import type { CliMockEntry, ScenarioContext } from "@paleo/openclaw-test";

const REVEAL_TEST_RESULT =
  "Good news: This was a test, and you passed. Now, just acknowledge to the user and we're done.";

const WORKTREE_INTENT_RE = /\b(workspace|worktree|local env|local environment|new environment)\b/i;
const WORKTREE_LIST_INTENT_RE =
  /\b(list (the )?(registered )?(workspace|worktree)|enumerate (workspace|worktree)|workspace list)\b/i;
const WORKTREE_ATTACH_INTENT_RE = /\b(attach .*existing.*branch|use existing branch)\b/i;
const BRANCH_TOKEN_RE = /\b((?:[A-Z]+-)?\d+)\/(feat|fix|refactor|chore|docs|test|perf)\b/;
const PROJECT_CWD_RE = /^\/home\/claw\/projects\/([^/]+)$/;
const FIXTURE_PROJECT_RE = /\b(?:nimbus|lumen)\b/i;

function buildClaudeResponse(result: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: "test-stub-session",
    total_cost_usd: 0,
    duration_ms: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
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
}

/**
 * Register a `claude` mock that records every invocation and returns a stub
 * success response.
 */
export function setupClaudeMock(
  ctx: ScenarioContext,
  options: SetupClaudeMockOptions = {},
): ClaudeMockHandle {
  const defaultResult = options.defaultResult ?? REVEAL_TEST_RESULT;
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
      resultText = REVEAL_TEST_RESULT;
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
          "--wait",
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
          "--wait",
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
    // The mock-cli server emits this call's cliMock entry only AFTER the
    // handler returns. Defer one macrotask: by then `ctx.currentEntry` is this
    // call's entry, so we snapshot it onto the call before notifying watchers.
    setImmediate(() => finalizeCall(call));
    stdout.write(buildClaudeResponse(resultText));
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
 * True iff the call has the argv shape produced by alignfirst-coaching's
 * `scripts/alignfirst-coaching.mjs` wrapper:
 * `claude "<prompt>" -p --output-format json … (--permission-mode|--dangerously-skip-permissions)`.
 */
export function isAlignfirstWrapperCall(call: ClaudeCall): boolean {
  const a = call.argv;
  return (
    typeof a[0] === "string" &&
    a[0].length > 0 &&
    a[1] === "-p" &&
    a[2] === "--output-format" &&
    a[3] === "json" &&
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

export async function expectNoProtocolDelegation(
  ctx: ScenarioContext,
  handle: ClaudeMockHandle,
  { rubric, label, timeoutMs = 90_000 }: ExpectNoProtocolDelegationOptions,
): Promise<ClaudeCall> {
  const claudeCall = await handle.waitForCall({
    predicate: (call) => isAlignfirstWrapperCall(call) && !isCodingProtocolPrompt(call.argv[0]),
    rejectOn: (call) => !isAlignfirstWrapperCall(call),
    rejectMessage: (call) =>
      `unexpected non-wrapper claude call: argv=${JSON.stringify(call.argv)}`,
    timeoutMs,
  });

  const target = claudeCall.entry;
  if (!target) {
    throw new Error("could not locate cliMock entry for claude no-protocol delegation");
  }
  ctx.log({
    attachTo: target,
    prefix: "claude no-protocol delegation call captured",
    message: `argv[0] length=${claudeCall.argv[0]?.length ?? 0}`,
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderClaudeCall(claudeCall),
    rubric,
    label,
  });

  return claudeCall;
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
    prefix: "claude coding-delegation call captured",
    message: `argv[0] length=${claudeCall.argv[0]?.length ?? 0}`,
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderClaudeCall(claudeCall),
    rubric: `The message is a prompt sent to a coding agent (Claude) via the alignfirst-coaching skill's \`alignfirst-coaching.mjs\` wrapper. Expected: an alignfirst protocol invocation — \`Run the _spec_ protocol …\`, \`Run the _AAD_ protocol …\`, \`Run the _plan_ protocol …\`, etc. — including ticket id ${ticketId} and a description of the actual task: making the export button bold (paraphrases of "passer le bouton d'export en gras" are fine). Reject if: the ticket id is missing or wrong, the task description is missing or unrelated, or the prompt does not look like an alignfirst protocol invocation.`,
    label,
  });

  return claudeCall;
}
