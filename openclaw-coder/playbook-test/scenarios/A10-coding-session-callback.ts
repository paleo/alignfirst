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
 * completion. We assert four things: alcoach is the exec the agent runs, an immediate "started in
 * the background" ack lands, alcoach's log reaches `status: succeeded`, and the callback drives a
 * completion report into the originating thread.
 *
 * The completion callback resumes an ISOLATED turn (no thread transcript, no threadId — OpenClaw
 * dispatches `/hooks/agent` as a fresh session). It therefore cannot thread-reply; the transform
 * (hooks/transforms/coding-callback.mjs) announces the turn's report into the channel conversation
 * with an explicit `to: channel:<room>`. OpenClaw lowercases the room in the session key, so the
 * completion lands under a case-variant conversation id — hence the case-insensitive conversation
 * match below, with no threadId requirement. The `status: succeeded` gate is the model-independent
 * proof the delegated session actually finished.
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

  // The callback's announce lands under a case-variant (OpenClaw lowercases the session-key room);
  // the agent may also free-stream a channel post in the exact-case conversation. Match either.
  const conversationMatches = (id: string): boolean =>
    id.toLowerCase() === ctx.conversationId.toLowerCase();

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
  const noFailFast = { failFastCliMockGraceMs: false, failFastUnmatchedOutbounds: false } as const;

  // Immediate "started in the background" ack: an outbound in this conversation whose text carries a
  // background-launch marker (only the ack matches — not the [WORK] header or worktree report). No
  // threadId requirement: the agent usually posts this in-thread, but sometimes free-streams it to
  // the parent channel — either surface is a valid ack, and STARTED_ACK_RE is the discriminator.
  const ack = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      conversationMatches(m.conversation.id) &&
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

  // Structural, model-independent proof the delegated coding session finished: alcoach rewrites its
  // per-run log frontmatter to `status: succeeded` when its detached `claude` child completes. This
  // is the ground truth the completion callback rides on — assert it before the user-facing report.
  const logPath = await waitForCodingSessionSucceeded(ctx, TICKET_ID, { timeoutMs: 120_000 });
  ctx.log(`coding-session log succeeded: ${logPath}`);

  // Callback-driven completion. alcoach's callback resumes an ISOLATED turn (no thread transcript),
  // so it can't thread-reply; the transform announces its report with an explicit `to: channel:<room>`
  // (see hooks/transforms/coding-callback.mjs). OpenClaw lowercases the session-key room, so the
  // announce lands under the LOWERCASED conversation id — distinct from every main-turn post, which
  // stays in the exact-case conversation (in-thread, or a channel free-stream like a git-verify
  // warning). Matching that case-variant strictly is what isolates the callback from the main turn's
  // channel noise. (Our conversationId always carries uppercase — `A10…` — so the lowercased form is
  // genuinely distinct.) Generous timeout for the real setup turn + mock stream delay + callback.
  const callbackConversationId = ctx.conversationId.toLowerCase();
  const completion = await ctx.waitForOutbound(
    (m) => m.direction === "outbound" && m.conversation.id === callbackConversationId,
    { timeoutMs: 240_000, sinceCursor: ack.nextCursor, ...noFailFast },
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the gateway for alcoach's per-run coding-session log reaching `status: succeeded`.
 * `find` (not a shell glob) so an absent match in any single project dir does not error; alcoach
 * writes the log under `<project>/.plans/<ticket>/coding-sessions/<stamp>.md`, and worktree `.plans`
 * symlinks back to the main project so either path resolves. Returns the matching log path.
 */
async function waitForCodingSessionSucceeded(
  ctx: ScenarioContext,
  ticketId: string,
  opts: { timeoutMs: number },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const findArgs = [
    "find",
    "/home/claw/projects",
    "-path",
    `*/.plans/${ticketId}/coding-sessions/*.md`,
    "-exec",
    "grep",
    "-l",
    "status: succeeded",
    "{}",
    "+",
  ];
  let lastStderr = "";
  while (Date.now() < deadline) {
    const r = await ctx.execInGateway(findArgs, { timeoutMs: 15_000 });
    const hit = r.stdout.trim().split("\n").find(Boolean);
    if (hit) return hit;
    lastStderr = r.stderr.trim();
    await delay(3_000);
  }
  throw new Error(
    `alcoach coding-session log for ${ticketId} never reached "status: succeeded" ` +
      `within ${opts.timeoutMs}ms${lastStderr ? ` (last stderr: ${lastStderr})` : ""}`,
  );
}
