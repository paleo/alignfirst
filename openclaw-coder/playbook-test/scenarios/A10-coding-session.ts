import type { ScenarioContext } from "@paleo/openclaw-test";
import { invokesAlcode, invokesClaudeDirectly } from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForCompletionReport,
} from "./_lib/coding-session.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import {
  assertNoChannelRootLeak,
  assertNoSelfThreadMessagePost,
  requireThreadId,
  waitForStarter,
} from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

// A<S> → ABC-0<S>N (README convention); scenario A10 → ABC-010N, first ticket ABC-0100.
const TICKET_ID = "ABC-0100";
const PROJECT = "nimbus";

/**
 * Regression for the real `@paleo/alcode` foreground run driven as an OpenClaw background exec. The
 * agent delegates coding work to the `alcode` CLI (never `claude` directly) by running it through
 * the `exec` tool with `timeout: 0`. alcode runs `claude` in the foreground and blocks; OpenClaw
 * backgrounds the exec, lets the agent post a "started" ack, and — when alcode exits — wakes the
 * SAME thread session via its native exec completion event (`tools.exec.notifyOnExit`). The woken
 * agent reads alcode's session file and reports the outcome in the thread. No callback, no gateway RPC, no
 * isolated turn.
 *
 * We assert four things: alcode is the exec the agent runs, an immediate "started in the
 * background" ack lands, alcode's session file reaches `status: succeeded`, and the completion wake drives a
 * finished-report into the same thread. The completion lands in the exact-case conversation (same
 * session, same thread) — no case-variant hacks. The `status: succeeded` gate is the
 * model-independent proof the delegated session actually finished.
 */
export default async function codingSession(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  setupClaudeMock(ctx, { streamDelayMs: 12000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Mets en place le workspace et lance directement le travail de code — ` +
      `tu as mon feu vert, ne me demande pas de validation, préviens-moi quand c'est terminé.`,
  });

  const starter = await waitForStarter(ctx, { sinceCursor: startCursor });
  const threadId = requireThreadId(starter);
  ctx.log({ attachTo: starter.entry, label: `thread opened ${threadId}` });

  // Deterministic proof the agent delegated through the real alcode CLI. Its own `claude`
  // subprocess is a cliMock, not an agent tool call, so `claude` must never appear at this level.
  const alcodeCall = await ctx.waitForAgentToolCall(invokesAlcode, {
    label: "agent delegates to the alcode CLI",
    timeoutMs: 180_000,
  });
  if (invokesClaudeDirectly(alcodeCall)) {
    throw new Error(
      `agent invoked claude directly instead of alcode: ${JSON.stringify(alcodeCall.input)}`,
    );
  }

  // Immediate "started in the background" ack, classified by a batch judge over the thread's
  // outbounds (see `waitForBackgroundStartedAck`) — tolerant of phrasing/language and of interleaved
  // reasoning narration. Free-streamed placement is enforced separately by the end-of-scenario
  // channel-root sweep, which fails a leaked ack with the real cause instead of a wait timeout.
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: starter.nextCursor,
    timeoutMs: 150_000,
    label: "background-started-ack",
  });

  // Structural, model-independent proof the delegated coding session finished: alcode rewrites its
  // per-run session file frontmatter to `status: succeeded` when its coding-agent child completes.
  // This is the ground truth the completion wake rides on — assert it before the user-facing report.
  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: TICKET_ID,
    timeoutMs: 120_000,
  });
  ctx.log(`coding-session file succeeded: ${sessionFilePath}`);

  // Completion wake: when the backgrounded alcode exec exits, OpenClaw wakes THIS thread session
  // (native `tools.exec.notifyOnExit` → system event + heartbeat). The woken agent reads the session
  // file and reports in the thread — the same session, so the completion carries the thread's id.
  // A batch judge picks the FINISHED report out of the thread window from `starter.nextCursor`,
  // distinguishing it from the earlier ack and any launch banner. Generous timeout: a real LLM wake turn.
  await waitForCompletionReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: starter.nextCursor,
    timeoutMs: 240_000,
    label: "completion-wake-report",
  });

  // The wake turn may still be streaming a final answer after the completion
  // post — the exact shape of the trailing-leak incident — so sweep longer.
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });
  assertNoSelfThreadMessagePost(ctx, threadId);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
