import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import {
  execCommandOf,
  execMatches,
  invokesAlcode,
  invokesCodingAgentDirectly,
  nthMatchingCall,
} from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForCompletionReport,
} from "./_lib/coding-session.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { setupCodingAgentMock, type CodingAgentMockHandle } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, assertNoSelfThreadMessagePost } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

// A<S> → ABC-0<S>N (README convention); scenario A12 → ABC-012N, first ticket ABC-0120.
const TICKET_ID = "ABC-0120";
const PROJECT = "nimbus";

// The delegation launch: an alcode PROTOCOL run. Discriminates against the other alcode execs a
// turn legitimately makes — the `--openclaw-guide` read, and the wake turn's protocol-less
// verification run ("Run the project's checks…"), which is foreground and chains no wake.
const isAlcodeLaunch = (call: AgentToolCall): boolean =>
  invokesAlcode(call) && execMatches(call, /--protocol/);

/**
 * Regression for the heartbeat-cooldown wake gate (incident `.plans/32/from-paleoclaw/
 * A1-diagnostic.md`): OpenClaw defers `event`-intent wakes whenever `now < nextDueMs`, and any
 * heartbeat run re-arms `nextDueMs = now + every` (24h here, as in production). A fresh gateway's
 * FIRST exec-exit wake always takes the never-ran-before bootstrap path — which is why every
 * one-delegation scenario stayed green while production lost completion reports. The SECOND
 * backgrounded run in the same cell is what exposes the gate: after the first wake run, the native
 * exec-exit notify sits a full interval away and is silently dropped. The alcode guide therefore
 * chains `openclaw system event --text … --mode now --session-key <KEY>` onto every launch — a
 * targeted `immediate`-intent wake the cooldown never defers.
 *
 * Two sequential delegations in one thread. The channel session only opens the thread, so both
 * launches come from the thread session: phase 1 on the user's handoff message, phase 2 on a
 * follow-up work request. Each launch exec must carry the chained wake (structural pin of the
 * guide-driven mechanism), and each run must produce a started ack, a `status: succeeded` session
 * file, and a completion report in the same thread — the second completion report is the
 * regression payload: without the chained wake it never arrives.
 */
export default async function sequentialCodingSessions(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  const codingAgent = setupCodingAgentMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const threadId = await runFirstDelegation(ctx, codingAgent);
  await runSecondDelegation(ctx, threadId);

  // The wake turn may still be streaming a final answer after the completion
  // post — the exact shape of the trailing-leak incident — so sweep longer.
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });
  await assertNoSelfThreadMessagePost(ctx, threadId, startCursor);
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/** Phase 1 — the channel bootstrap, then the handoff message that starts the work. */
async function runFirstDelegation(
  ctx: ScenarioContext,
  codingAgent: CodingAgentMockHandle,
): Promise<string> {
  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Préviens-moi quand c'est terminé.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });
  const phase1Cursor = await sendInThread(
    ctx,
    starter.threadId,
    "Vas-y, préviens-moi ici quand c'est terminé.",
  );

  await expectDelegationChain(ctx, {
    threadId: starter.threadId,
    sinceCursor: phase1Cursor,
    launchIndex: 1,
  });
  return starter.threadId;
}

/**
 * Phase 2 — a small follow-up work request lands in the same thread. Its waits scan from a cursor
 * taken before the inbound.
 */
async function runSecondDelegation(ctx: ScenarioContext, threadId: string): Promise<void> {
  const phase2Cursor = await sendInThread(
    ctx,
    threadId,
    `Deuxième étape sur le même ticket ${TICKET_ID} : ajoute une infobulle « Exporter les ` +
      `données » sur ce bouton d'export. Préviens-moi ici quand c'est terminé.`,
  );

  await expectDelegationChain(ctx, {
    threadId,
    sinceCursor: phase2Cursor,
    launchIndex: 2,
  });
}

interface DelegationChainOptions {
  threadId: string;
  /** Bus cursor taken before this phase's agent activity; every wait of the phase scans from it. */
  sinceCursor: number;
  /** 1-based rank of this phase's alcode launch among ALL aggregated launch calls. */
  launchIndex: number;
}

/**
 * One delegation's full chain: the alcode launch exec (with the chained `openclaw system event`
 * wake — the guide-driven mechanism this scenario pins), the started ack, the `status: succeeded`
 * session file (`minCount = launchIndex`: both runs share `.plans/<ticket>/_alcode/`, so an
 * earlier file matches immediately), and the completion report in the work thread.
 */
async function expectDelegationChain(
  ctx: ScenarioContext,
  opts: DelegationChainOptions,
): Promise<void> {
  const { threadId, sinceCursor, launchIndex } = opts;

  // `waitForAgentToolCall` matches against all aggregated calls, so a plain predicate would
  // re-match phase 1's launch: discriminate by count and take the newest. The coding-agent
  // subprocess is a cliMock, not an OpenClaw agent tool call.
  const launch = await ctx.waitForAgentToolCall(nthMatchingCall(isAlcodeLaunch, launchIndex), {
    label: `agent delegates to the alcode CLI (launch #${launchIndex})`,
    timeoutMs: 180_000,
  });
  if (invokesCodingAgentDirectly(launch)) {
    throw new Error(
      `agent invoked a coding agent directly instead of alcode: ${JSON.stringify(launch.input)}`,
    );
  }
  // Structural pin of the chained completion wake — the outcome-level asserts below would also
  // pass on a bootstrap-path native wake (phase 1 always does), so assert the mechanism itself.
  const command = execCommandOf(launch);
  if (command === undefined) throw new Error("alcode launch call carries no exec command");
  ctx.assertRegex(
    command,
    /openclaw system event/,
    `launch #${launchIndex}: chains an \`openclaw system event\` wake`,
  );
  ctx.assertRegex(command, /--session-key/, `launch #${launchIndex}: wake targets a --session-key`);

  // The started ack: a batch judge over the thread's outbounds (see `waitForBackgroundStartedAck`).
  // Tolerant of phrasing/language and of interleaved reasoning narration — the message that tells
  // the user the work is running qualifies whatever its exact shape.
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor,
    timeoutMs: 150_000,
    label: `background-started-ack-${launchIndex}`,
  });

  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: TICKET_ID,
    timeoutMs: 120_000,
    minCount: launchIndex,
  });
  ctx.log(`coding-session file #${launchIndex} succeeded: ${sessionFilePath}`);

  // The completion report: a batch judge picks the FINISHED report out of the thread window,
  // distinguishing it from the earlier ack and any launch banner — so both phases scan from
  // `sinceCursor` (phase 2's is taken before its inbound, so a stray duplicate wake of an earlier
  // run sits before it and is not considered). The judge, not a cursor offset, does the disambiguation.
  await waitForCompletionReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor,
    timeoutMs: 420_000,
    label: `completion-wake-report-${launchIndex}`,
  });
}
