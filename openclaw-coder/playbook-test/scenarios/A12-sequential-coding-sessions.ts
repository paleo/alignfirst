import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import {
  execCommandOf,
  execMatches,
  invokesAlcode,
  invokesClaudeDirectly,
  nthMatchingCall,
} from "./_lib/agent-tool-calls.ts";
import {
  COMPLETION_RE,
  FORWARD_LOOKING_ACK_RE,
  isAnnouncement,
  LAUNCH_OR_SETUP_RE,
  STARTED_ACK_RE,
  waitForCodingSessionSucceeded,
} from "./_lib/coding-session.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

// A<S> → ABC-0<S>N (README convention); scenario A12 → ABC-012N, first ticket ABC-0120.
const TICKET_ID = "ABC-0120";
const PROJECT = "nimbus";

const STARTED_RUBRIC =
  "A short message telling the user that a background task has been kicked off through the coding " +
  "agent and is now running — e.g. 'je lance le travail', 'started', 'working on it in the " +
  "background', 'agent lancé en background', 'je te préviens dès que c'est terminé'. A promise to " +
  "report back when it's done still counts (the work is not finished yet). Does NOT claim the work " +
  "is already finished.";

const COMPLETION_RUBRIC =
  "A message reporting that a previously-launched background coding-agent task has FINISHED — the " +
  "delegated coding session completed and the agent is relaying the outcome (the change is done, or " +
  "a summary/result of the AAD/coding session, often with a checkmark). Examples: 'c'est fait', " +
  "'the coding agent finished successfully', 'j'ai terminé', '✅ … finished'. Does NOT merely say " +
  "the work is still starting or in progress.";

// The launch invocation, not the `alcode --openclaw-guide` read (also an alcode exec).
const isAlcodeLaunch = (call: AgentToolCall): boolean =>
  invokesAlcode(call) && !execMatches(call, /--openclaw-guide/);

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
 * Two sequential delegations in one thread. Phase 1 mirrors A10 (channel-session delegation, wake
 * report routed to the thread via `--meta`); phase 2 sends a follow-up WITH go-ahead into the
 * thread (fresh thread session, as in A11), covering both session-key shapes. Each launch exec
 * must carry the chained wake (structural pin of the guide-driven mechanism), and each run must
 * produce a started ack, a `status: succeeded` session file, and a completion report in the same
 * thread — the second completion report is the regression payload: without the chained wake it
 * never arrives.
 */
export default async function sequentialCodingSessions(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  setupClaudeMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const threadId = await runFirstDelegation(ctx, startCursor);
  await runSecondDelegation(ctx, threadId);

  // The wake turn may still be streaming a final answer after the completion
  // post — the exact shape of the trailing-leak incident — so sweep longer.
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/** Phase 1 — channel inbound with green light, as in A10. Returns the work thread's id. */
async function runFirstDelegation(ctx: ScenarioContext, startCursor: number): Promise<string> {
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Mets en place le workspace et lance directement le travail de code — ` +
      `tu as mon feu vert, ne me demande pas de validation, préviens-moi quand c'est terminé.`,
  });

  const starter = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(starter);
  ctx.log({ attachTo: starter.entry, label: `thread opened ${threadId}` });

  await expectDelegationChain(ctx, {
    threadId,
    sinceCursor: starter.nextCursor,
    launchIndex: 1,
  });
  return threadId;
}

/**
 * Phase 2 — a small follow-up work request WITH an explicit go-ahead lands IN the thread (as in
 * A11 phase 2), activating a fresh thread session. Phase-2 waits scan from a cursor taken before
 * this inbound.
 */
async function runSecondDelegation(ctx: ScenarioContext, threadId: string): Promise<void> {
  const phase2Cursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text:
      `Deuxième étape sur le même ticket ${TICKET_ID} : ajoute une infobulle « Exporter les ` +
      `données » sur ce bouton d'export. Tu as mon feu vert, lance directement le travail et ` +
      "préviens-moi ici quand c'est terminé.",
    threadId,
  });

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
  // re-match phase 1's launch: discriminate by count and take the newest. Its own `claude`
  // subprocess is a cliMock, not an agent tool call, so `claude` must never appear at this level.
  const launch = await ctx.waitForAgentToolCall(nthMatchingCall(isAlcodeLaunch, launchIndex), {
    label: `agent delegates to the alcode CLI (launch #${launchIndex})`,
    timeoutMs: 180_000,
  });
  if (invokesClaudeDirectly(launch)) {
    throw new Error(
      `agent invoked claude directly instead of alcode: ${JSON.stringify(launch.input)}`,
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

  // Structural, single-match predicates (no per-message classifier). `waitForOutbound` returns the
  // first match in a poll batch but advances the cursor past the whole batch, so each wait must
  // match exactly ONE target, else a later message sharing a batch with an earlier match is skipped.
  const noFailFast = { failFastCliMockGraceMs: false, failFastUnmatchedOutbounds: false } as const;

  const ack = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      STARTED_ACK_RE.test(m.text),
    { timeoutMs: 150_000, sinceCursor, ...noFailFast },
  );
  ctx.log({ attachTo: ack.entry, label: `background-started ack #${launchIndex} received` });
  await ctx.judgeLLM({
    attachTo: ack.entry,
    message: ack.match.text,
    rubric: STARTED_RUBRIC,
    label: `background-started-ack-${launchIndex}`,
  });

  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: TICKET_ID,
    timeoutMs: 120_000,
    minCount: launchIndex,
  });
  ctx.log(`coding-session file #${launchIndex} succeeded: ${sessionFilePath}`);

  // Phase 1 scans from BEFORE the ack (`sinceCursor`), as in A10: if a slow poll lands the ack
  // and the completion in one batch, an ack-relative cursor would skip the completion. Later
  // phases scan from AFTER their ack instead: a duplicate wake of an EARLIER run (the native
  // exec-exit notice on top of the chained wake, e.g. right after a gateway start) can re-report
  // that run's outcome before this phase's ack and would satisfy the predicate. The batch hazard
  // does not bite here — the completion trails the ack by at least the mock's streamDelayMs.
  // The predicate matches only the FINISHED report: COMPLETION_RE, minus the forward-looking ack
  // and launch/setup openings (see A10 for why not the whole STARTED_ACK_RE).
  const completionCursor = launchIndex === 1 ? sinceCursor : ack.nextCursor;
  const completion = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId === threadId &&
      COMPLETION_RE.test(m.text) &&
      !isAnnouncement(FORWARD_LOOKING_ACK_RE, m.text) &&
      !isAnnouncement(LAUNCH_OR_SETUP_RE, m.text),
    { timeoutMs: 240_000, sinceCursor: completionCursor, ...noFailFast },
  );
  ctx.log({ attachTo: completion.entry, label: `completion report #${launchIndex} received` });
  await ctx.judgeLLM({
    attachTo: completion.entry,
    message: completion.match.text,
    rubric: COMPLETION_RUBRIC,
    label: `completion-wake-report-${launchIndex}`,
  });
}
