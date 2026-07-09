import type { CliMockEntry, ScenarioContext } from "@paleo/openclaw-test";

// The coding agent's completion result, written into the alcode session file's
// `---- Result ----` block. A real coding agent's result describes the task it
// was actually given, so the mock derives it from the prompt (see
// `codingResultFor`) rather than returning one constant — a static result that
// names the wrong task on a follow-up delegation reads to a diligent agent as a
// failed run (result describes something else, no matching change), which then
// distrusts its own report and tries to re-do or "fix" the work.
//
// Each entry reads like a real successful coding outcome — no "this was a test"
// meta-commentary, which invited the reading agent to doubt the result.
const BOLD_BUTTON_RESULT =
  "Done. The export button is now bold — updated the component's font weight and verified it renders. Changes committed on the ticket branch.";
const TOOLTIP_RESULT =
  'Done. Added a "Exporter les données" tooltip to the export button — set the native `title` attribute and verified it shows on hover. Changes committed on the ticket branch.';
const GENERIC_CODING_RESULT =
  "Done. Implemented the requested change and verified it. Changes committed on the ticket branch.";

const BOLD_INTENT_RE = /\b(bold|gras|font[-\s]?weight)\b/i;
const TOOLTIP_INTENT_RE = /\b(tooltip|infobulle|title attribute|attribut title)\b/i;

// Pick the result that matches the task described in the coding-protocol prompt,
// mirroring how a real coding agent reports the change it actually made. Tooltip
// is checked first: a follow-up tooltip task still names the export button (which
// was bolded earlier), so a naive bold check would win on both.
function codingResultFor(prompt: string): string {
  if (TOOLTIP_INTENT_RE.test(prompt)) return TOOLTIP_RESULT;
  if (BOLD_INTENT_RE.test(prompt)) return BOLD_BUTTON_RESULT;
  return GENERIC_CODING_RESULT;
}

const WORKTREE_INTENT_RE = /\b(workspace|worktree|local env|local environment|new environment)\b/i;
const WORKTREE_LIST_INTENT_RE =
  /\b(list (the )?(registered )?(workspace|worktree)|enumerate (workspace|worktree)|workspace list)\b/i;
const WORKTREE_ATTACH_INTENT_RE = /\b(attach .*existing.*branch|use existing branch)\b/i;
// Branch is `{TICKET_ID}/{1-3-words}` — the suffix is a short free-form
// description the agent derives, not a fixed work-type vocabulary. Accept any
// slug (kebab or snake, any case), so the mock recognizes whatever the agent
// picked.
const BRANCH_TOKEN_RE = /\b((?:[A-Z]+-)?\d+)\/([a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*)\b/;
const PROJECT_CWD_RE = /^\/home\/claw\/projects\/([^/]+)$/;
const FIXTURE_PROJECT_RE = /\b(?:nimbus|lumen)\b/i;

// alcode drives `claude` with `-p --output-format stream-json --verbose`, reading the NDJSON
// event stream line-by-line: it needs a system/init line carrying a session_id, optional
// assistant/text lines, and a terminal `result` line (session_id + result + is_error). This mirrors
// the canned stream A3's runner expects.
function buildClaudeStreamResponse(sessionId: string, result: string): string {
  const events: unknown[] = [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "assistant", message: { content: [{ type: "text", text: "Working on it…" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: result }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: sessionId,
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ];
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let streamSessionCounter = 0;
function nextStreamSessionId(): string {
  streamSessionCounter += 1;
  return `alcode-mock-${Date.now().toString(36)}-${streamSessionCounter}`;
}

export type ClaudeCall = { argv: string[]; cwd: string; entry?: CliMockEntry };

export interface WaitForCallOptions {
  predicate: (call: ClaudeCall) => boolean;
  /** Optional predicate; matching calls reject the wait with `rejectMessage`. */
  rejectOn?: (call: ClaudeCall) => boolean;
  rejectMessage?: (call: ClaudeCall) => string;
  timeoutMs: number;
}

export interface ClaudeMockHandle {
  claudeCalls: ClaudeCall[];
  /** Resolves on the next captured claude call satisfying `predicate`. */
  waitForCall: (options: WaitForCallOptions) => Promise<ClaudeCall>;
}

export interface SetupClaudeMockOptions {
  /** Override the result returned when the prompt is not a coding-protocol or worktree-creation call. */
  defaultResult?: string;
  /**
   * Delay (ms) before the stream-json (alcode) branch emits its NDJSON. alcode runs `claude` in
   * the foreground and blocks on it, so this delay is what makes the whole alcode exec long enough
   * for OpenClaw to background it (and the agent to post a "started" ack) before it exits and the
   * completion wake fires. Default 4000.
   */
  streamDelayMs?: number;
}

/**
 * Register a `claude` mock that records every invocation and returns a stub
 * success response.
 */
export function setupClaudeMock(
  ctx: ScenarioContext,
  options: SetupClaudeMockOptions = {},
): ClaudeMockHandle {
  const defaultResult = options.defaultResult ?? GENERIC_CODING_RESULT;
  const streamDelayMs = options.streamDelayMs ?? 4000;
  const claudeCalls: ClaudeCall[] = [];
  type Watcher = {
    options: WaitForCallOptions;
    resolve: (c: ClaudeCall) => void;
    reject: (err: Error) => void;
  };
  const watchers: Watcher[] = [];
  const finalizedCalls = new WeakSet<ClaudeCall>();

  ctx.mockCli("claude", async ({ argv, cwd, stdout, stderr }) => {
    const call: ClaudeCall = { argv, cwd };
    claudeCalls.push(call);
    const prompt = typeof argv[0] === "string" ? argv[0] : "";
    if (prompt === "--version" || prompt === "-v") {
      stdout.write("2.0.0 (Claude Code)\n");
      return 0;
    }
    if (prompt === "--help" || prompt === "-h") {
      stdout.write(
        "Usage: claude <prompt> [-p] [--output-format json] [--permission-mode <mode>]\n",
      );
      return 0;
    }
    let resultText: string;
    if (isCodingProtocolPrompt(prompt)) {
      resultText = codingResultFor(prompt);
    } else if (looksLikeWorktreeList(prompt)) {
      const project = resolveProject(prompt, cwd);
      if (!project) {
        stderr.write(
          "mock-claude: could not resolve project for worktree list.\n" +
            `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
        );
        return 1;
      }
      const exec = await ctx.execInGateway(
        ["pnpm", "--dir", `/home/claw/projects/${project}`, "workspace", "list"],
        { timeoutMs: 30_000 },
      );
      if (exec.exitCode !== 0) {
        stderr.write(
          `mock-claude: pnpm workspace list failed (exit ${exec.exitCode}).\n` +
            `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
        );
        return exec.exitCode;
      }
      resultText = exec.stdout.trim() || `No worktrees registered for ${project}.`;
    } else if (looksLikeWorktreeAttach(prompt)) {
      const parsed = parseWorktreeRequest(prompt, cwd);
      if (!parsed) {
        stderr.write(
          "mock-claude: could not resolve project+branch for worktree attach.\n" +
            `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
        );
        return 1;
      }
      const exec = await ctx.execInGateway(
        [
          "pnpm",
          "--dir",
          `/home/claw/projects/${parsed.project}`,
          "workspace",
          "setup",
          parsed.branch,
        ],
        { timeoutMs: 120_000 },
      );
      if (exec.exitCode !== 0) {
        stderr.write(
          `mock-claude: pnpm workspace setup ${parsed.branch} failed (exit ${exec.exitCode}).\n` +
            `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
        );
        return exec.exitCode;
      }
      resultText =
        exec.stdout.trim() || `Worktree attached to ${parsed.branch} on ${parsed.project}.`;
    } else if (looksLikeWorktreeCreation(prompt)) {
      const parsed = parseWorktreeRequest(prompt, cwd);
      if (!parsed) {
        stderr.write(
          "mock-claude: could not resolve project+branch for worktree creation.\n" +
            `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
        );
        return 1;
      }
      const exec = await ctx.execInGateway(
        [
          "pnpm",
          "--dir",
          `/home/claw/projects/${parsed.project}`,
          "workspace",
          "setup",
          parsed.branch,
          "-c",
        ],
        { timeoutMs: 120_000 },
      );
      if (exec.exitCode !== 0) {
        stderr.write(
          `mock-claude: pnpm workspace setup ${parsed.branch} -c failed (exit ${exec.exitCode}).\n` +
            `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
        );
        return exec.exitCode;
      }
      resultText = exec.stdout.trim() || `Worktree ${parsed.branch} ready for ${parsed.project}.`;
    } else {
      resultText = defaultResult;
    }
    // alcode drives `claude` in stream-json in the foreground and blocks on it. Emulate a short run
    // (so OpenClaw backgrounds the alcode exec and the agent's "started" ack lands first), then
    // stream the NDJSON transcript alcode parses (init → text → result).
    await delay(streamDelayMs);
    stdout.write(buildClaudeStreamResponse(nextStreamSessionId(), resultText));
    // The mock-cli server emits this call's cliMock entry only AFTER the handler returns. Defer one
    // macrotask past the return so `ctx.currentEntry` is this call's entry, then snapshot it onto the
    // call before notifying watchers. (Scheduled here, after the await, so the delay does not elapse
    // before the entry exists.)
    setImmediate(() => finalizeCall(call));
    return 0;
  });

  function finalizeCall(call: ClaudeCall): void {
    if (ctx.currentEntry?.kind === "cliMock") call.entry = ctx.currentEntry;
    finalizedCalls.add(call);
    const pending = watchers.splice(0, watchers.length);
    for (const w of pending) {
      if (w.options.rejectOn?.(call)) {
        const msg =
          w.options.rejectMessage?.(call) ?? `unexpected claude call: ${JSON.stringify(call.argv)}`;
        w.reject(new Error(msg));
        continue;
      }
      if (w.options.predicate(call)) {
        w.resolve(call);
        continue;
      }
      watchers.push(w);
    }
  }

  const waitForCall = (options: WaitForCallOptions): Promise<ClaudeCall> => {
    const existing = claudeCalls.find((c) => finalizedCalls.has(c) && options.predicate(c));
    if (existing) return Promise.resolve(existing);
    return new Promise<ClaudeCall>((resolve, reject) => {
      const watcher: Watcher = { options, resolve, reject };
      watchers.push(watcher);
      setTimeout(() => {
        const idx = watchers.indexOf(watcher);
        if (idx !== -1) {
          watchers.splice(idx, 1);
          reject(new Error(`no matching claude CLI call within ${options.timeoutMs}ms`));
        }
      }, options.timeoutMs);
    });
  };

  return { claudeCalls, waitForCall };
}

/**
 * True iff the call has the argv shape alcode emits when driving `claude`:
 * `claude "<prompt>" -p --output-format stream-json --verbose … (--permission-mode auto|--dangerously-skip-permissions) [--resume <id>] [--model <m>]`.
 * This is the only shape alcode produces, so it doubles as "this claude call came from alcode".
 */
export function isAlignfirstWrapperCall(call: ClaudeCall): boolean {
  const a = call.argv;
  return (
    typeof a[0] === "string" &&
    a[0].length > 0 &&
    a[1] === "-p" &&
    a[2] === "--output-format" &&
    a[3] === "stream-json" &&
    a[4] === "--verbose" &&
    (a.includes("--permission-mode") || a.includes("--dangerously-skip-permissions"))
  );
}

function looksLikeWorktreeList(prompt: string): boolean {
  return WORKTREE_LIST_INTENT_RE.test(prompt);
}

function looksLikeWorktreeAttach(prompt: string): boolean {
  return WORKTREE_ATTACH_INTENT_RE.test(prompt) && BRANCH_TOKEN_RE.test(prompt);
}

function looksLikeWorktreeCreation(prompt: string): boolean {
  return WORKTREE_INTENT_RE.test(prompt) && BRANCH_TOKEN_RE.test(prompt);
}

function resolveProject(prompt: string, cwd: string): string | undefined {
  const cwdMatch = cwd.match(PROJECT_CWD_RE);
  if (cwdMatch?.[1]) return cwdMatch[1];
  const promptProject = prompt.match(FIXTURE_PROJECT_RE);
  return promptProject?.[0].toLowerCase();
}

function parseWorktreeRequest(
  prompt: string,
  cwd: string,
): { project: string; branch: string } | undefined {
  const branchMatch = prompt.match(BRANCH_TOKEN_RE);
  if (!branchMatch) return undefined;
  const branch = `${branchMatch[1]}/${branchMatch[2]}`;
  const project = resolveProject(prompt, cwd);
  if (!project) return undefined;
  return { project, branch };
}

const CODING_PROTOCOL_RE =
  /^Run the _(spec|AAD|plan|description|read|review|merge)_ protocol from the \*alignfirst\* skill\./;

/** True iff `prompt` opens with an alignfirst coding-protocol header. */
export function isCodingProtocolPrompt(prompt: string | undefined): boolean {
  return prompt !== undefined && CODING_PROTOCOL_RE.test(prompt);
}

/** Render a captured claude invocation as a single text blob for the judge. */
export function renderClaudeCall(call: ClaudeCall): string {
  return [`cwd: ${call.cwd}`, `argv: ${JSON.stringify(call.argv)}`].join("\n");
}

export interface ExpectNoProtocolDelegationOptions {
  rubric: string;
  label: string;
  timeoutMs?: number;
}

export interface NoProtocolDelegationResult {
  call: ClaudeCall;
  /**
   * Bus cursor captured the instant the delegation is detected, before the
   * judge runs. The judge is a multi-second Anthropic round-trip; the agent
   * posts its summary right after the claude mock returns, so a cursor taken
   * after the judge lands past the summary and strands it.
   */
  cursorAfterDelegation: number;
}

export async function expectNoProtocolDelegation(
  ctx: ScenarioContext,
  handle: ClaudeMockHandle,
  { rubric, label, timeoutMs = 90_000 }: ExpectNoProtocolDelegationOptions,
): Promise<NoProtocolDelegationResult> {
  const claudeCall = await handle.waitForCall({
    predicate: (call) => isAlignfirstWrapperCall(call) && !isCodingProtocolPrompt(call.argv[0]),
    rejectOn: (call) => !isAlignfirstWrapperCall(call),
    rejectMessage: (call) =>
      `unexpected non-wrapper claude call: argv=${JSON.stringify(call.argv)}`,
    timeoutMs,
  });
  const cursorAfterDelegation = await ctx.getCursor();

  const target = claudeCall.entry;
  if (!target) {
    throw new Error("could not locate cliMock entry for claude no-protocol delegation");
  }
  ctx.log({
    attachTo: target,
    label: "claude no-protocol delegation call captured",
    extra: { argv0Length: claudeCall.argv[0]?.length ?? 0 },
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderClaudeCall(claudeCall),
    rubric,
    label,
  });

  return { call: claudeCall, cursorAfterDelegation };
}

export interface ExpectCodingDelegationOptions {
  ticketId: string;
  /** Optional extra predicate, e.g. project-name filter for multi-project. */
  matches?: (call: ClaudeCall) => boolean;
  timeoutMs?: number;
  label?: string;
}

export async function expectCodingDelegation(
  ctx: ScenarioContext,
  handle: ClaudeMockHandle,
  options: ExpectCodingDelegationOptions,
): Promise<ClaudeCall> {
  const { ticketId, matches, timeoutMs = 90_000, label = "claude-coding-delegation" } = options;
  const claudeCall = await handle.waitForCall({
    predicate: (call) =>
      isAlignfirstWrapperCall(call) &&
      isCodingProtocolPrompt(call.argv[0]) &&
      (matches?.(call) ?? true),
    rejectOn: (call) => !isAlignfirstWrapperCall(call),
    rejectMessage: (call) =>
      `unexpected non-wrapper claude call: argv=${JSON.stringify(call.argv)}`,
    timeoutMs,
  });

  const target = claudeCall.entry;
  if (!target) {
    throw new Error("could not locate cliMock entry for claude coding-delegation");
  }
  ctx.log({
    attachTo: target,
    label: "claude coding-delegation call captured",
    extra: { argv0Length: claudeCall.argv[0]?.length ?? 0 },
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderClaudeCall(claudeCall),
    rubric: `The message is a prompt sent to a coding agent (Claude) via the \`alcode\` CLI. Expected: an alignfirst protocol invocation — \`Run the _spec_ protocol …\`, \`Run the _AAD_ protocol …\`, \`Run the _plan_ protocol …\`, etc. — including ticket id ${ticketId} and a description of the actual task: making the export button bold (paraphrases of "passer le bouton d'export en gras" are fine). Reject if: the ticket id is missing or wrong, the task description is missing or unrelated, or the prompt does not look like an alignfirst protocol invocation.`,
    label,
  });

  return claudeCall;
}
