import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, invokesAlcode, invokesClaudeDirectly } from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForCompletionReport,
} from "./_lib/coding-session.ts";
import {
  assertBranchForTicket,
  escapeRegExp,
  waitForAnyWorktreeDir,
} from "./_lib/fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import {
  isCodingProtocolPrompt,
  setupClaudeMock,
  type ClaudeMockHandle,
} from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import {
  assertNoChannelRootLeak,
  assertNoSelfThreadMessagePost,
  requireThreadId,
} from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import type { Step } from "./_lib/types.ts";

// A<S> → ABC-0<S>N (README convention); scenario A11 → ABC-011N, first ticket ABC-0110.
const TICKET_ID = "ABC-0110";
const PROJECT = "nimbus";

// The report block asserts a bootstrap-status keyword, as in workspace-flow.ts.
const bootstrapStatusRe = /\b(ready|running|in[\s-]?progress|failed|ok|prêt|prête|en cours|échou)/i;

/**
 * Path-3 regression (incident `.plans/30/D1-spec.md`): a FRESH THREAD SESSION — the user's
 * follow-up inside an existing thread, not the channel session A10 covers — launches the
 * backgrounded alcode run, and the exec-exit wake must land the completion report back in the same
 * thread. On real Discord this launch path backgrounded the run and the wake never fired.
 *
 * Phase 1 has the channel session set up the workspace WITHOUT delegating (the inbound withholds
 * the green light); the structural proof is that the claude mock sees no coding-protocol call
 * before the go-ahead. Phase 2 sends the go-ahead INTO the thread — activating a fresh thread
 * session, the only session prompted after the nudge — and asserts the A10 chain from there:
 * alcode exec with `background: true, timeout: 0`, started ack, session file `status: succeeded`,
 * completion wake in the same thread, no channel-root leak.
 */
export default async function threadSessionDelegation(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  const claude = setupClaudeMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const setup = await runSetupPhaseWithoutDelegation(ctx, claude);
  await runThreadDelegationPhase(ctx, setup.threadId, startCursor);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/**
 * Phase 1 — the channel session sets up the workspace, no delegation. Mirrors A02's phase 1
 * (starter → `[WORK]` header → worktree on disk → settled workspace report), but the inbound
 * withholds the green light, so the turn must END on the workspace report. `runWorkspaceFlow`
 * bundles the go-ahead nudge and the instant-stub delegation expectations, so the flow is rebuilt
 * here from the individual helpers.
 */
async function runSetupPhaseWithoutDelegation(
  ctx: ScenarioContext,
  claude: ClaudeMockHandle,
): Promise<Step> {
  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text:
      `Nouvelle fonctionnalité sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Prépare le workspace, mais ne lance aucun travail de code ` +
      "sans mon feu vert.",
  });

  const starterWait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });
  const starter: Step = {
    match: starterWait.match,
    entry: starterWait.entry,
    threadId,
    nextCursor: starterWait.nextCursor,
  };

  const ack = await waitForSetupAck(ctx, {
    threadId,
    prevId: starterWait.match.id,
    sinceCursor: starterWait.nextCursor,
    ticketId: TICKET_ID,
    project: PROJECT,
    audience: "tech",
    seedCandidate: starter,
  });
  ctx.log({ attachTo: ack.entry, label: "[WORK] header received" });

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(PROJECT, TICKET_ID, {
    timeoutMs: 120_000,
  });
  const branch = assertBranchForTicket(worktreeDir, TICKET_ID);
  const settled = await settleOnWorkspaceReport(ctx, ack, worktreeDir, branch);

  // Structural proof phase 2's delegation comes from the THREAD session: before the go-ahead, the
  // claude mock must have seen no coding-protocol call (worktree-creation calls are fine).
  const protocolCall = claude.claudeCalls.find((c) => isCodingProtocolPrompt(c.argv[0]));
  if (protocolCall) {
    throw new Error(
      `coding-protocol claude call before the go-ahead: ${JSON.stringify(protocolCall.argv[0]?.slice(0, 200))}`,
    );
  }
  ctx.log("no coding-protocol claude call before the go-ahead — OK");

  return settled;
}

/**
 * Let the agent's setup turn settle on its workspace report BEFORE the go-ahead — nudging mid-turn
 * disrupts the flow (see `runWorkspaceFlow`). Best-effort like there: assert the block when the
 * agent posts it, tolerate a weak model that reports readiness conversationally.
 */
async function settleOnWorkspaceReport(
  ctx: ScenarioContext,
  prevStep: Step,
  worktreeDir: string,
  branch: string,
): Promise<Step> {
  const dirName = worktreeDir.slice(worktreeDir.lastIndexOf("/") + 1);
  const branchRe = new RegExp(`\\b${escapeRegExp(branch)}\\b`, "i");
  const locatorRe = new RegExp(`${escapeRegExp(dirName)}|slot\\s*\\d{3,5}`, "i");
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === prevStep.threadId &&
      m.id !== prevStep.match.id &&
      locatorRe.test(m.text),
    { timeoutMs: 90_000, sinceCursor: prevStep.nextCursor },
  ).catch(() => null);
  if (!reportWait) {
    ctx.log(
      "workspace report: no structured block (readiness reported conversationally) — tolerated",
    );
    return prevStep;
  }
  const reportText = reportWait.match.text;
  ctx.log({ attachTo: reportWait.entry, label: "workspace report received" });
  ctx.assertRegex(reportText, locatorRe, "workspace-report: worktree locator (dir or slot)");
  ctx.assertRegex(reportText, branchRe, "workspace-report: branch name");
  ctx.assertRegex(reportText, bootstrapStatusRe, "workspace-report: bootstrap status");
  return {
    match: reportWait.match,
    entry: reportWait.entry,
    threadId: prevStep.threadId,
    nextCursor: reportWait.nextCursor,
  };
}

/**
 * Phase 2 — the go-ahead lands IN the thread, activating a fresh thread session (the incident's
 * launch path), which must delegate through alcode as a background exec and, on the exec-exit
 * wake, report completion in the same thread. Same cursor discipline as A10: single-match
 * predicates, completion scanned from before the ack.
 */
async function runThreadDelegationPhase(
  ctx: ScenarioContext,
  threadId: string,
  startCursor: number,
): Promise<void> {
  const goAheadCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: "Feu vert : lance le travail. Préviens-moi ici quand c'est terminé.",
    threadId,
  });

  // The launch invocation, not the `alcode --openclaw-guide` read (also an alcode exec, but
  // without the background fields). Its own `claude` subprocess is a cliMock, never an agent tool
  // call, so a direct `claude` exec at this level is the incident's wrong path.
  const alcodeCall = await ctx.waitForAgentToolCall(
    (c) => invokesAlcode(c) && !execMatches(c, /--openclaw-guide/),
    { label: "thread session delegates to the alcode CLI", timeoutMs: 180_000 },
  );
  if (invokesClaudeDirectly(alcodeCall)) {
    throw new Error(
      `agent invoked claude directly instead of alcode: ${JSON.stringify(alcodeCall.input)}`,
    );
  }
  // The incident's regression: the agent passed a finite `timeout` (300/600) instead of the
  // guide-mandated `background: true, timeout: 0` (field names per the exec input in A10 reports).
  const input = (alcodeCall.input ?? {}) as { background?: unknown; timeout?: unknown };
  ctx.assertEqual(input.background, true, "alcode exec: background === true");
  ctx.assertEqual(input.timeout, 0, "alcode exec: timeout === 0");

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
  assertNoSelfThreadMessagePost(ctx, threadId);
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
