import type { BusMessage, ScenarioContext } from "@paleo/openclaw-test";
import { EXTERNAL_PROJECT_PARENT, PRIMARY_PROJECT_PARENT } from "./project-fixtures.ts";

// Two agent messages carry the delegation outcome — the "started in the background" ack and the
// "finished" completion report. Both are classified by an LLM judge, never by a lexical regex: the
// message a capable model actually emits varies too widely (a terse "je lance l'ajout de l'infobulle"
// vs. a promise "je te préviens dès que c'est terminé"), and a regex both misses legitimate phrasings
// and mis-catches reasoning narration ("let me launch the coding agent first…") as if it were the ack.
// The judge reads intent. Each thread outbound is judged as it arrives (single-message rubric — the
// framing the judge handles reliably); interleaved narration simply judges false and is skipped rather
// than failing the run. `waitForBackgroundStartedAck` / `waitForCompletionReport` below own this.

const STARTED_ACK_RUBRIC =
  "This is a single message an assistant posted in a chat thread after a user asked it to run a coding " +
  "task. PASS if the message tells the user the coding work has been kicked off / launched and is now " +
  "running (in the background), OR promises to report back when it is done. Both a present-tense launch " +
  "('je lance le travail', 'working on it in the background', 'agent lancé en background') and a " +
  "perfective launch announcement ('Deuxième étape lancée 🚀', 'work started', 'C'est noté — je lance " +
  "l'ajout') qualify — the key is that it tells the USER the work is now underway. FAIL if it is only " +
  "the assistant thinking out loud with no user-facing start signal ('let me launch the coding agent " +
  "first', 'OK, branch is clean'), a bare [WORKSPACE] setup banner with no launch statement, or a " +
  "claim that the work is already FINISHED.";

const COMPLETION_RUBRIC =
  "This is a single message an assistant posted in a chat thread while running a coding task. PASS if it " +
  "reports to the user that the coding task FINISHED — the delegated work completed and it is relaying " +
  "the outcome (change done, or a result summary, often with a ✅): 'c'est fait', 'the coding agent " +
  "finished successfully', 'j'ai terminé', '✅ … terminé'. FAIL if it merely says the work is still " +
  "starting or in progress ('je te préviens dès que c'est terminé', 'je lance le travail'), or is a " +
  "workspace/launch announcement that carries a ✅ only for setup readiness ('Status: ready ✅ | " +
  "Lancement…').";

const FINDINGS_RUBRIC =
  "This is a single message an assistant posted in a chat thread after delegating a read-only " +
  "investigation (a 'look into this' task, not a code change) to a coding agent that has finished. PASS " +
  "if it relays the investigation FINDINGS to the user — a summary or answer from the analysis (a " +
  "paraphrase 'D'après l'analyse, …' or a direct relay 'C'est fait.' / 'It's done.'), optionally with a " +
  "trailing question or offer about next steps (which fix to apply, whether to proceed, open a ticket). " +
  "FAIL if it is a launch/setup announcement (a worktree was created, the work has started) or pretends " +
  "the coding work already started.";

export interface JudgedReportOptions {
  conversationId: string;
  /** When set, only outbounds carrying this threadId are considered. */
  threadId?: string;
  sinceCursor: number;
  timeoutMs: number;
  /** Assertion label recorded on the judged messages. */
  label: string;
}

/** A thread outbound the judge accepted as the awaited report. */
export interface Candidate {
  message: BusMessage;
}

/**
 * Wait for the agent to tell the user, in the thread, that the coding work started in the background.
 * Tolerant of phrasing and language; interleaved reasoning narration is ignored (see STARTED_ACK_RUBRIC).
 */
export async function waitForBackgroundStartedAck(
  ctx: ScenarioContext,
  opts: JudgedReportOptions,
): Promise<Candidate> {
  return collectAndJudge(ctx, opts, STARTED_ACK_RUBRIC, "background-started ack");
}

/**
 * Wait for the completion report — the agent relaying to the user, in the thread, that the delegated
 * coding run finished. Call only after the session file reached `succeeded` (the ground truth). Tolerant
 * of phrasing and language; a still-in-progress ack or a launch banner does not satisfy it (see COMPLETION_RUBRIC).
 */
export async function waitForCompletionReport(
  ctx: ScenarioContext,
  opts: JudgedReportOptions,
): Promise<Candidate> {
  return collectAndJudge(ctx, opts, COMPLETION_RUBRIC, "completion report");
}

/**
 * Wait for the investigation findings — the agent relaying, in the thread, the result of a
 * `read`-protocol delegation (A03). Judged per message like the ack/completion waits: tolerant of
 * phrasing and language, and it judges the earlier launch/ack lines false rather than needing a regex
 * to exclude them.
 */
export async function waitForFindingsReport(
  ctx: ScenarioContext,
  opts: JudgedReportOptions,
): Promise<Candidate> {
  return collectAndJudge(ctx, opts, FINDINGS_RUBRIC, "investigation findings report");
}

/**
 * Poll the thread's outbounds and judge each new one, in order, against `rubric` — returning the first
 * that passes. Throws on timeout. This replaces the old regex-select-then-`judgeLLM` pattern: a broad
 * structural predicate collects EVERY candidate (via `ctx.poll`, which returns the whole batch —
 * `waitForOutbound` would drop the non-first messages of a batch when it advances its cursor), and the
 * judge decides intent per message, so narration and phrasing variance judge false and are skipped
 * rather than failing the run. Judges once per fresh outbound (bounded judge cost). `what` names the
 * awaited message for the timeout error.
 */
async function collectAndJudge(
  ctx: ScenarioContext,
  opts: JudgedReportOptions,
  rubric: string,
  what: string,
): Promise<Candidate> {
  const { conversationId, threadId, label } = opts;
  const deadline = Date.now() + opts.timeoutMs;
  let cursor = opts.sinceCursor;
  let seen = 0;

  const matches = (m: BusMessage): boolean =>
    m.direction === "outbound" &&
    m.conversation.id === conversationId &&
    (threadId === undefined || m.threadId === threadId) &&
    m.text.trim().length > 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { messages, nextCursor } = await ctx.poll({
      sinceCursor: cursor,
      timeoutMs: Math.min(remaining, 15_000),
    });
    cursor = nextCursor;
    for (const message of messages.filter(matches)) {
      ++seen;
      if (await judgeMatches(ctx, rubric, label, message)) return { message };
    }
  }
  throw new Error(
    `${label}: no ${what} among ${seen} thread outbound(s) within ${opts.timeoutMs}ms`,
  );
}

/** Judge one message against `rubric`; true iff it passes. A non-match must not throw the wait. */
async function judgeMatches(
  ctx: ScenarioContext,
  rubric: string,
  label: string,
  message: BusMessage,
): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ matches: boolean; reason: string }>({
    message: message.text,
    prompt: rubric,
    returnType: '{ "matches": boolean, "reason": string }',
    label,
  });
  return parsed.matches === true;
}

/**
 * Poll the gateway for alcode's per-run coding-session file reaching `status: succeeded` — the
 * model-independent proof the delegated session finished, and the ground truth the completion
 * wake rides on. `find` (not a shell glob) so an absent match in any single project dir does not
 * error; alcode writes under `<project>/.plans/<ticket>/_alcode/<stamp>.md` (or
 * `.plans/_alcode/` without a ticket), and worktree `.plans` symlinks back to the main
 * project so either path resolves. Sequential delegations of one ticket share the `_alcode/`
 * dir, so an earlier run's file matches immediately: `minCount` (default 1) requires that many
 * distinct succeeded files. Returns the newest matching session file path (the stamp in the file
 * name sorts chronologically).
 */
export async function waitForCodingSessionSucceeded(
  ctx: ScenarioContext,
  opts: { ticketId?: string; timeoutMs: number; minCount?: number },
): Promise<string> {
  const minCount = opts.minCount ?? 1;
  const sessionsDir = opts.ticketId ? `.plans/${opts.ticketId}/_alcode` : ".plans/_alcode";
  const deadline = Date.now() + opts.timeoutMs;
  const findArgs = [
    "find",
    PRIMARY_PROJECT_PARENT,
    EXTERNAL_PROJECT_PARENT,
    "-path",
    `*/${sessionsDir}/*.md`,
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
    const hits = r.stdout.trim().split("\n").filter(Boolean);
    const newest = hits.sort().at(-1);
    if (hits.length >= minCount && newest !== undefined) {
      await assertSessionAgent(ctx, newest);
      return newest;
    }
    lastStderr = r.stderr.trim();
    await delay(3_000);
  }
  throw new Error(
    `fewer than ${minCount} alcode coding-session file(s) under ${sessionsDir} reached ` +
      `"status: succeeded" within ${opts.timeoutMs}ms${lastStderr ? ` (last stderr: ${lastStderr})` : ""}`,
  );
}

async function assertSessionAgent(ctx: ScenarioContext, path: string): Promise<void> {
  const selectedAgent = process.env.ALIGNFIRST_CODE_AGENT;
  if (selectedAgent !== "claude" && selectedAgent !== "codex") {
    throw new Error("ALIGNFIRST_CODE_AGENT must be set to claude or codex for playbook scenarios");
  }
  const result = await ctx.execInGateway(["grep", "-q", `^agent: ${selectedAgent}$`, path]);
  if (result.exitCode !== 0) {
    throw new Error(`session ${path} does not record selected agent ${selectedAgent}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
