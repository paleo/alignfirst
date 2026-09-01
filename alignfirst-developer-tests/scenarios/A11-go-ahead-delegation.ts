import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, invokesAlcode, invokesCodingAgentDirectly } from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForCompletionReport,
} from "./_lib/coding-session.ts";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
  type CodingAgentMockHandle,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, assertNoSelfThreadMessagePost } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";
import type { Step } from "./_lib/types.ts";
import { settleOnWorkspaceReport } from "./_lib/workspace-flow.ts";

// A<S> → ABC-0<S>N (README convention); scenario A11 → ABC-011N, first ticket ABC-0110.
const TICKET_ID = "ABC-0110";
const PROJECT = "nimbus";

/**
 * An explicit hold, then the green light — two turns in the work thread.
 *
 * The thread session starts work without asking for validation (that gate is gone), so the way to
 * separate setup from coding is for the user to withhold the green light themselves. Phase 1 does
 * exactly that: "prépare le workspace, ne lance aucun travail de code sans mon feu vert" must
 * produce a workspace and no coding-protocol call. Phase 2 releases it and asserts the launch path
 * from the incident `.plans/30/D1-spec.md`: a backgrounded alcode exec (`background: true`,
 * `timeoutSeconds: 0`) whose exec-exit wake lands the completion report back in the same thread.
 */
export default async function threadSessionDelegation(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  const codingAgent = setupCodingAgentMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });

  await runSetupPhaseWithoutDelegation(ctx, codingAgent, starter);
  await runGoAheadPhase(ctx, starter.threadId, startCursor);
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/**
 * Phase 1 — the user asks for the workspace and withholds the green light. The structural proof is
 * that the coding-agent mock sees no coding-protocol call; worktree-creation calls are fine.
 */
async function runSetupPhaseWithoutDelegation(
  ctx: ScenarioContext,
  codingAgent: CodingAgentMockHandle,
  starter: Step,
): Promise<void> {
  await sendInThread(
    ctx,
    starter.threadId,
    "Prépare le workspace, mais ne lance aucun travail de code sans mon feu vert.",
  );

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 120_000,
  });
  const branch = assertBranchForTicket(worktreeDir, TICKET_ID);
  await settleOnWorkspaceReport(ctx, starter, worktreeDir, branch);

  const protocolCall = codingAgent.codingAgentCalls.find((call) =>
    isCodingProtocolPrompt(extractCodingPrompt(call)),
  );
  if (protocolCall) {
    throw new Error(
      `coding-protocol coding-agent call despite the hold: ${JSON.stringify(extractCodingPrompt(protocolCall)?.slice(0, 200))}`,
    );
  }
  ctx.log("no coding-protocol coding-agent call before the go-ahead — OK");
}

/**
 * Phase 2 — the go-ahead releases the hold. The session must delegate through alcode as a
 * background exec and, on the exec-exit wake, report completion in the same thread.
 */
async function runGoAheadPhase(
  ctx: ScenarioContext,
  threadId: string,
  startCursor: number,
): Promise<void> {
  const goAheadCursor = await sendInThread(
    ctx,
    threadId,
    "Feu vert : lance le travail. Préviens-moi ici quand c'est terminé.",
  );

  // The launch invocation, not the `alcode --openclaw-guide` read (also an alcode exec, but
  // without the background fields). Its coding-agent subprocess is a cliMock, never an OpenClaw
  // agent tool call, so a direct coding-agent exec at this level is the incident's wrong path.
  const alcodeCall = await ctx.waitForAgentToolCall(
    (c) => invokesAlcode(c) && !execMatches(c, /--openclaw-guide/),
    { label: "thread session delegates to the alcode CLI", timeoutMs: 180_000 },
  );
  if (invokesCodingAgentDirectly(alcodeCall)) {
    throw new Error(
      `agent invoked a coding agent directly instead of alcode: ${JSON.stringify(alcodeCall.input)}`,
    );
  }
  // The incident's regression: the agent passed a finite timeout (300/600) instead of the
  // guide-mandated `background: true, timeoutSeconds: 0` (OpenClaw 2026.8 exec field names).
  const input = (alcodeCall.input ?? {}) as { background?: unknown; timeoutSeconds?: unknown };
  ctx.assertEqual(input.background, true, "alcode exec: background === true");
  ctx.assertEqual(input.timeoutSeconds, 0, "alcode exec: timeoutSeconds === 0");

  // The started ack, classified by a batch judge over the thread's outbounds (tolerant of
  // phrasing/language and interleaved reasoning narration).
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: goAheadCursor,
    timeoutMs: 150_000,
    label: "background-started-ack",
  });

  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: TICKET_ID,
    timeoutMs: 120_000,
  });
  ctx.log(`coding-session file succeeded: ${sessionFilePath}`);

  // Scan from BEFORE the ack (goAheadCursor): the batch judge picks the FINISHED report out of the
  // thread window, distinguishing it from the earlier ack and any launch banner.
  await waitForCompletionWake(ctx, threadId, goAheadCursor);

  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });
  await assertNoSelfThreadMessagePost(ctx, threadId, startCursor);
}

/**
 * The completion-wake wait, with a diagnostic on timeout: the gateway's `last-heartbeat` is logged
 * before rethrowing — a stale `ts` distinguishes a wake-scheduler wedge (the incident) from a slow
 * model turn.
 */
async function waitForCompletionWake(ctx: ScenarioContext, threadId: string, sinceCursor: number) {
  try {
    return await waitForCompletionReport(ctx, {
      conversationId: ctx.conversationId,
      threadId,
      sinceCursor,
      timeoutMs: 240_000,
      label: "completion-wake-report",
    });
  } catch (error) {
    const hb = await ctx.execInGateway(["openclaw", "gateway", "call", "last-heartbeat"], {
      timeoutMs: 15_000,
    });
    ctx.log(
      `last-heartbeat on completion timeout (exit ${hb.exitCode}): ` +
        `${hb.stdout.trim()}${hb.stderr.trim() ? ` | stderr: ${hb.stderr.trim()}` : ""}`,
    );
    throw error;
  }
}
