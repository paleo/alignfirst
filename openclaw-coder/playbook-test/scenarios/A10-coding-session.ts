import type { ScenarioContext } from "@paleo/openclaw-test";
import { invokesAlcode, invokesClaudeDirectly } from "./_lib/agent-tool-calls.ts";
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

// The completion report (after the exec wake) says the work FINISHED. Distinct from STARTED_ACK_RE
// (which promises a future update) so the completion wait can scan from before the ack and still
// match only the completion — avoiding coupling to the ack wait's batch cursor.
const COMPLETION_RE = /termin[ée]|c'est (fait|bon)|finished|succès|success|done|✅/i;

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
  // threadId requirement: the agent usually posts this in-thread, but sometimes free-streams it to
  // the parent channel — either surface is a valid ack, and STARTED_ACK_RE is the discriminator.
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
  // per-run session file frontmatter to `status: succeeded` when its `claude` child completes. This is the
  // ground truth the completion wake rides on — assert it before the user-facing report.
  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, TICKET_ID, {
    timeoutMs: 120_000,
  });
  ctx.log(`coding-session file succeeded: ${sessionFilePath}`);

  // Completion wake: when the backgrounded alcode exec exits, OpenClaw wakes THIS thread session
  // (native `tools.exec.notifyOnExit` → system event + heartbeat). The woken agent reads the session file and
  // reports in the thread — the same session, so the completion carries the thread's id and lands in
  // the exact-case conversation. Scan from `starter.nextCursor` (before the ack), not `ack.nextCursor`:
  // if a slow poll lands the ack and completion in one batch, an ack-relative cursor would skip the
  // completion. The predicate matches only the FINISHED report (COMPLETION_RE and not the forward-
  // looking STARTED_ACK_RE), so the ack itself never matches. Generous timeout: a real LLM wake turn.
  const completion = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId === threadId &&
      COMPLETION_RE.test(m.text) &&
      !STARTED_ACK_RE.test(m.text),
    { timeoutMs: 240_000, sinceCursor: starter.nextCursor, ...noFailFast },
  );
  ctx.log({ attachTo: completion.entry, label: "completion-wake report received" });
  await ctx.judgeLLM({
    attachTo: completion.entry,
    message: completion.match.text,
    rubric: COMPLETION_RUBRIC,
    label: "completion-wake-report",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the gateway for alcode's per-run coding-session file reaching `status: succeeded`.
 * `find` (not a shell glob) so an absent match in any single project dir does not error; alcode
 * writes the session file under `<project>/.plans/<ticket>/coding-sessions/<stamp>.md`, and worktree `.plans`
 * symlinks back to the main project so either path resolves. Returns the matching session file path.
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
    `alcode coding-session file for ${ticketId} never reached "status: succeeded" ` +
      `within ${opts.timeoutMs}ms${lastStderr ? ` (last stderr: ${lastStderr})` : ""}`,
  );
}
