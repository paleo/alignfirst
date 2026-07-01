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
 * Detection is structural (no per-message content marker). The callback resumes the thread session
 * with `deliver: false` (hooks/transforms/coding-callback.mjs), so the completion lands as a thread
 * outbound in the SAME conversation — the first thread post after the ack. The `status: succeeded`
 * gate is the model-independent proof the delegated session actually finished.
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

  // Structural, model-independent proof the delegated coding session finished: alcoach rewrites its
  // per-run log frontmatter to `status: succeeded` when its detached `claude` child completes. This
  // is the ground truth the completion callback rides on — assert it before the user-facing report.
  const logPath = await waitForCodingSessionSucceeded(ctx, TICKET_ID, { timeoutMs: 120_000 });
  ctx.log(`coding-session log succeeded: ${logPath}`);

  // Callback-driven completion, delivered into the ORIGINAL thread. alcoach's completion callback
  // resumes the thread session with `deliver: false` (see hooks/transforms/coding-callback.mjs), so
  // the agent reports through its own `message` `thread-reply` — the report lands as a thread
  // outbound in this same conversation, after the ack. It is the first such thread outbound past the
  // ack: the worktree/[WORK] posts precede the ack, and a verify-warning (if any) goes to the parent
  // channel without a threadId, so a single-match wait from `ack.nextCursor` picks it cleanly.
  // Generous timeout for the real setup turn + the mock stream delay + the callback round-trip.
  const completion = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
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
