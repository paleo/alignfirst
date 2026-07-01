import type { ScenarioContext } from "@paleo/openclaw-test";
import { invokesAlcoach, invokesClaudeDirectly } from "./_lib/agent-tool-calls.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

// A<S> → ABC-0<S>N (README convention); scenario A10 → ABC-010N, first ticket ABC-0100.
const TICKET_ID = "ABC-0100";
const PROJECT = "nimbus";

// The "started in the background" ack reliably carries one of these markers (the playbook tells the
// agent it launched a background run and will report back). Kept off `en cours`, which also appears
// in some `[WORK]` headers.
const STARTED_ACK_RE = /background|arri[èe]re-plan|pr[ée]vien|tiens au courant|te reviens|informe/i;

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
 * Regression for the real `@paleo/alcoach` background + callback path. The agent delegates coding
 * work to the `alcoach` CLI (never `claude` directly), which runs `claude` as a detached child in
 * `--output-format stream-json` and POSTs back to the gateway's `/hooks/coding` endpoint on
 * completion. We assert three things: alcoach is the exec the agent runs, an immediate "started in
 * the background" ack lands, and the callback drives a completion outbound in the same conversation.
 *
 * Detection is structural (no per-message LLM classifier) so the scenario stays cheap and robust:
 * the callback-driven completion is announced to `channel:<room>` where the room is the session
 * key's lowercased conversation id, so it surfaces under a case-variant conversation id — a
 * deterministic marker. The started ack is the last thread outbound before that completion.
 */
export default async function codingSessionCallback(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Longer stream delay than the default so the "started" ack reliably precedes the callback.
  setupClaudeMock(ctx, { streamDelayMs: 6000 });
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

  // Deterministic proof the agent delegated through the real alcoach CLI. Its own `claude`
  // subprocess is a cliMock, not an agent tool call, so `claude` must never appear at this level.
  const alcoachCall = await ctx.waitForAgentToolCall(invokesAlcoach, {
    label: "agent delegates to the alcoach CLI",
    timeoutMs: 180_000,
  });
  if (invokesClaudeDirectly(alcoachCall)) {
    throw new Error(
      `agent invoked claude directly instead of alcoach: ${JSON.stringify(alcoachCall.input)}`,
    );
  }

  // Structural, single-match predicates (no per-message classifier). `waitForOutbound` returns the
  // first match in a poll batch but advances the cursor past the whole batch, so each wait must
  // match exactly ONE target, else a later message sharing a batch with an earlier match is skipped.
  const lowerId = ctx.conversationId.toLowerCase();
  const noFailFast = { failFastCliMockGraceMs: false, failFastUnmatchedOutbounds: false } as const;

  // Immediate "started in the background" ack: a thread outbound in this conversation whose text
  // carries a background-launch marker (only the ack matches — not the [WORK] header or worktree report).
  const ack = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined &&
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

  // Callback-driven completion: alcoach's completion callback is announced to `channel:<room>`,
  // where the room is the session key's lowercased conversation id, so it surfaces under a
  // case-variant conversation id — the ONLY outbound that matches this predicate. Because no other
  // message matches, we scan from `starter.nextCursor` (not `ack.nextCursor`): `waitForOutbound`
  // advances its cursor past a whole poll batch after the first match, so a batch shared with an
  // earlier match would skip this one — a unique predicate scanned from the start avoids that.
  // Generous timeout for the real setup turn + the mock stream delay + the callback round-trip.
  const completion = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id !== ctx.conversationId &&
      m.conversation.id.toLowerCase() === lowerId,
    { timeoutMs: 240_000, sinceCursor: starter.nextCursor, ...noFailFast },
  );
  ctx.log({ attachTo: completion.entry, label: "callback-driven completion received" });
  await ctx.judgeLLM({
    attachTo: completion.entry,
    message: completion.match.text,
    rubric: COMPLETION_RUBRIC,
    label: "callback-driven-completion",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
