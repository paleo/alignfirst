import type { ScenarioContext } from "@paleo/openclaw-test";
import { invokesAlcode, invokesClaudeDirectly } from "./_lib/agent-tool-calls.ts";
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

// A<S> → ABC-0<S>N (README convention); scenario A10 → ABC-010N, first ticket ABC-0100.
const TICKET_ID = "ABC-0100";
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

  const starter = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
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

  // Structural, single-match predicates (no per-message classifier). `waitForOutbound` returns the
  // first match in a poll batch but advances the cursor past the whole batch, so each wait must
  // match exactly ONE target, else a later message sharing a batch with an earlier match is skipped.
  const noFailFast = { failFastCliMockGraceMs: false, failFastUnmatchedOutbounds: false } as const;

  // Immediate "started in the background" ack: an outbound in this conversation whose text carries a
  // background-launch marker (only the ack matches — not the [WORK] header or worktree report). No
  // threadId requirement here — STARTED_ACK_RE is the discriminator, and placement is enforced
  // globally by the end-of-scenario channel-root sweep, which fails a free-streamed ack with the
  // real cause instead of an ack-wait timeout.
  const ack = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      STARTED_ACK_RE.test(m.text),
    { timeoutMs: 150_000, sinceCursor: starter.nextCursor, ...noFailFast },
  );
  ctx.log({ attachTo: ack.entry, label: "background-started ack received" });
  await ctx.judgeLLM({
    attachTo: ack.entry,
    message: ack.match.text,
    rubric: STARTED_RUBRIC,
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
  // (native `tools.exec.notifyOnExit` → system event + heartbeat). The woken agent reads the session file and
  // reports in the thread — the same session, so the completion carries the thread's id and lands in
  // the exact-case conversation. Scan from `starter.nextCursor` (before the ack), not `ack.nextCursor`:
  // if a slow poll lands the ack and completion in one batch, an ack-relative cursor would skip the
  // completion. The predicate matches only the FINISHED report: COMPLETION_RE, minus the forward-
  // looking FORWARD_LOOKING_ACK_RE (an ack that says "I'll tell you when done" — NOT the whole
  // STARTED_ACK_RE, whose `arri[èe]re-plan` marker also appears in a genuine "…en arrière-plan est
  // terminée" completion), and not a launch/setup line (a "Bootstrap: ready ✅ | Lancement…"
  // workspace report carries a ✅ with no ack marker). Generous timeout: a real LLM wake turn.
  const completion = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId === threadId &&
      COMPLETION_RE.test(m.text) &&
      !isAnnouncement(FORWARD_LOOKING_ACK_RE, m.text) &&
      !isAnnouncement(LAUNCH_OR_SETUP_RE, m.text),
    { timeoutMs: 240_000, sinceCursor: starter.nextCursor, ...noFailFast },
  );
  ctx.log({ attachTo: completion.entry, label: "completion-wake report received" });
  await ctx.judgeLLM({
    attachTo: completion.entry,
    message: completion.match.text,
    rubric: COMPLETION_RUBRIC,
    label: "completion-wake-report",
  });

  // The wake turn may still be streaming a final answer after the completion
  // post — the exact shape of the trailing-leak incident — so sweep longer.
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
