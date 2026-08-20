import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, invokesAlcode, invokesCodingAgentDirectly } from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForCompletionReport,
} from "./_lib/coding-session.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, assertNoSelfThreadMessagePost } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

// A<S> → ABC-0<S>N (README convention); scenario A10 → ABC-010N, first ticket ABC-0100.
const TICKET_ID = "ABC-0100";
const PROJECT = "nimbus";

/**
 * Regression for the real `@paleo/alcode` foreground run driven as an OpenClaw background exec, and
 * for the handoff contract under pressure: the channel message spells out an immediate green light
 * ("lance directement, ne me demande pas de validation") and the channel session must still do
 * nothing but open the thread.
 *
 * The thread session then runs the whole chain. It delegates to the `alcode` CLI, never to the
 * selected coding agent directly. Alcode runs its child in the foreground and
 * blocks; OpenClaw backgrounds the exec, lets the agent post a "started" ack, and — when alcode
 * exits — wakes the SAME thread session. The woken agent reads alcode's session file and reports
 * the outcome in the thread, no `--meta` needed since the session owns the surface.
 *
 * We assert four things: alcode is the exec the agent runs, an immediate "started in the
 * background" ack lands, alcode's session file reaches `status: succeeded`, and the completion wake
 * drives a finished-report into the same thread. The `status: succeeded` gate is the
 * model-independent proof the delegated session actually finished.
 */
export default async function codingSession(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  const codingAgent = setupCodingAgentMock(ctx, { streamDelayMs: 12000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Mets en place le workspace et lance directement le travail de code — ` +
      `tu as mon feu vert, ne me demande pas de validation, préviens-moi quand c'est terminé.`,
    project: PROJECT,
    ticketId: TICKET_ID,
    audience: "tech",
    codingAgent,
  });
  const threadId = starter.threadId;
  const goAheadCursor = await sendInThread(
    ctx,
    threadId,
    "Vas-y, préviens-moi ici quand c'est terminé.",
  );

  // The coding-agent subprocess is a cliMock, not an OpenClaw agent tool call.
  const alcodeCall = await ctx.waitForAgentToolCall(
    (c) => invokesAlcode(c) && !execMatches(c, /--openclaw-guide/),
    { label: "agent delegates to the alcode CLI", timeoutMs: 180_000 },
  );
  if (invokesCodingAgentDirectly(alcodeCall)) {
    throw new Error(
      `agent invoked a coding agent directly instead of alcode: ${JSON.stringify(alcodeCall.input)}`,
    );
  }

  // Immediate "started in the background" ack, classified by a batch judge over the thread's
  // outbounds (see `waitForBackgroundStartedAck`) — tolerant of phrasing/language and of interleaved
  // reasoning narration. Free-streamed placement is enforced separately by the end-of-scenario
  // channel-root sweep, which fails a leaked ack with the real cause instead of a wait timeout.
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: goAheadCursor,
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
  // A batch judge picks the FINISHED report out of the thread window, distinguishing it from the
  // earlier ack and any launch banner. Generous timeout: a real LLM wake turn.
  await waitForCompletionReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: goAheadCursor,
    timeoutMs: 240_000,
    label: "completion-wake-report",
  });

  // The wake turn may still be streaming a final answer after the completion
  // post — the exact shape of the trailing-leak incident — so sweep longer.
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });
  await assertNoSelfThreadMessagePost(ctx, threadId, startCursor);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
