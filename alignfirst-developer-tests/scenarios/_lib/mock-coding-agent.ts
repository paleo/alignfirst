import { basename, dirname } from "node:path";
import { text } from "node:stream/consumers";
import type { CliMockEntry, ScenarioContext } from "@paleo/openclaw-test";
import { FIXTURE_PROJECT_PATHS } from "./project-fixtures.ts";

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

// A verification delegation ("manually test the recent change…") answered with a
// coding result reads as a failed run: the agent distrusts it and re-delegates
// verification with escalating methods (dev server → curl → Playwright), never
// posting its completion report (A12 Slack, artifacts 2026-08-23T12-46-49). So
// verification prompts get a verification-shaped answer, like a real alcode.
const BOLD_VERIFY_RESULT =
  "Verified. Started the dev server cleanly (no errors in the logs) and checked the home page: the export button renders bold. No regressions found.";
const TOOLTIP_VERIFY_RESULT =
  'Verified. Started the dev server cleanly (no errors in the logs) and checked the home page: the export button shows the "Exporter les données" tooltip on hover. No regressions found.';
const GENERIC_VERIFY_RESULT =
  "Verified. Started the dev server cleanly (no errors in the logs) and manually checked the change: it behaves as described. No regressions found.";
const LOG_REVIEW_RESULT =
  "Reviewed .local-wt/logs/dev-server.log. No errors, warnings, or unusual behavior found.";

const VERIFICATION_INTENT_RE =
  /(manual(?:ly)?\s+(?:test|verify|check)|\b(?:test|verify)\b[\s\S]*\b(?:change|button|page|fix|feature)\b)/i;
const LOG_REVIEW_INTENT_RE =
  /\b(?:inspect|review|check|read|analy[sz]e)\b[\s\S]{0,160}\b(?:logs?|journal)\b|\b(?:logs?|journal)\b[\s\S]{0,160}\b(?:errors?|warnings?|unusual)\b/iu;
const PUSH_REQUEST_RE =
  /(?:^|[;:,]\s*)(?:(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:push|poussez?|publiez?)\b[^.!?\n]{0,160}\b(?:branch|branche|commit|changes?|origin|upstream)\b|(?:please\s+)?publish\b[^.!?\n]{0,160}\b(?:branch|commit|changes?|origin|upstream)\b|run\s+`?git\s+push\b|commit\b[^.!?\n]{0,120}\b(?:and|then|\+)\s*,?\s*(?:push|publish)\b)/iu;
const PUSH_PROHIBITION_RE =
  /\b(?:do\s+not|don't|never|without)\s+(?:(?:run|a|any|git)\s+|`)*(?:push|publish)(?:ing)?\b/iu;
const PUSH_REFERENCE_RE =
  /\b(?:explain|describe|documentation|docs?|example|mentions?|says?|after\s+(?:approval|confirmation)|until\s+(?:approved|confirmed))\b/iu;

// Pick the result that matches the task described in the coding-protocol prompt,
// mirroring how a real coding agent reports the change it actually made. Tooltip
// is checked first: a follow-up tooltip task still names the export button (which
// was bolded earlier), so a naive bold check would win on both.
function codingResultFor(prompt: string): string {
  if (TOOLTIP_INTENT_RE.test(prompt)) return TOOLTIP_RESULT;
  if (BOLD_INTENT_RE.test(prompt)) return BOLD_BUTTON_RESULT;
  return GENERIC_CODING_RESULT;
}

function verificationResultFor(prompt: string): string {
  if (TOOLTIP_INTENT_RE.test(prompt)) return TOOLTIP_VERIFY_RESULT;
  if (BOLD_INTENT_RE.test(prompt)) return BOLD_VERIFY_RESULT;
  return GENERIC_VERIFY_RESULT;
}

const WORKTREE_INTENT_RE = /\b(workspace|worktree|local env|local environment|new environment)\b/i;
const WORKTREE_LIST_INTENT_RE =
  /\b(list (the )?(registered )?(workspace|worktree)|enumerate (workspace|worktree)|workspace list)\b/i;
const WORKTREE_ATTACH_INTENT_RE = /\b(attach .*existing.*branch|use existing branch)\b/i;
// Branch is `{TICKET_ID}/{1-3-words}` — the suffix is a short free-form
// description the agent derives, not a fixed work-type vocabulary. Accept any
// slug (kebab or snake, any case), so the mock recognizes whatever the agent
// picked.
const BRANCH_TOKEN_RE = /\b((?:[a-zA-Z]+-)?\d+)\/([a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*)\b/;
const FIXTURE_PROJECT_RE = /\b(?:nimbus|lumen|orion)\b/i;

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

// Every alias alcode advertises resolves here: an agent that picks `--model astra` for a light task
// otherwise gets "the bundled catalog contains no matching model" (A12 Slack, 2026-09-11T15-30-11).
const CODEX_MODEL_CATALOG = {
  models: [
    { slug: "gpt-5.5-astra" },
    { slug: "gpt-5.6-astra" },
    { slug: "gpt-5.5-sol" },
    { slug: "gpt-5.6-sol" },
    { slug: "gpt-5.5-terra" },
    { slug: "gpt-5.6-terra" },
    { slug: "gpt-5.4-luna" },
    { slug: "gpt-5.6-luna" },
  ],
};

export type CodexResponseVariant =
  | "success"
  | "multipleMessages"
  | "turnFailed"
  | "topLevelError"
  | "completedErrorItem"
  | "malformed"
  | "authenticationFailure"
  | "modelRejection"
  | "nonzeroStderr";

export function buildCodexStreamResponse(
  sessionId: string,
  result: string,
  variant: CodexResponseVariant = "success",
): { stdout: string; stderr?: string; exitCode: number } {
  const line = (event: unknown): string => JSON.stringify(event);
  const started = line({ type: "thread.started", thread_id: sessionId });
  const completed = line({ type: "turn.completed" });
  switch (variant) {
    case "success":
      return {
        stdout: `${started}\n${line({ type: "item.completed", item: { type: "agent_message", text: result } })}\n${completed}\n`,
        exitCode: 0,
      };
    case "multipleMessages":
      return {
        stdout:
          `${started}\n` +
          `${line({ type: "item.completed", item: { type: "agent_message", text: "Intermediate result" } })}\n` +
          `${line({ type: "item.completed", item: { type: "agent_message", text: result } })}\n` +
          `${completed}\n`,
        exitCode: 0,
      };
    case "turnFailed":
      return {
        stdout: `${started}\n${line({ type: "turn.failed", error: { message: "Codex protocol failure" } })}\n`,
        exitCode: 0,
      };
    case "topLevelError":
      return {
        stdout: `${started}\n${line({ type: "error", message: "Codex service error" })}\n`,
        exitCode: 0,
      };
    case "completedErrorItem":
      return {
        stdout: `${started}\n${line({ type: "item.completed", item: { type: "error", message: "Codex item error" } })}\n`,
        exitCode: 0,
      };
    case "malformed":
      return { stdout: `${started}\n{malformed json\n${completed}\n`, exitCode: 0 };
    case "authenticationFailure":
      return {
        stdout: `${started}\n${line({ type: "error", message: "Not logged in. Run codex login" })}\n`,
        exitCode: 1,
      };
    case "modelRejection":
      return {
        stdout: `${started}\n${line({ type: "turn.failed", error: { message: "Model is not supported for this account" } })}\n`,
        exitCode: 1,
      };
    case "nonzeroStderr":
      return { stdout: "", stderr: "Codex child exited unexpectedly", exitCode: 7 };
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let streamSessionCounter = 0;
function nextStreamSessionId(): string {
  streamSessionCounter += 1;
  return `alcode-mock-${Date.now().toString(36)}-${streamSessionCounter}`;
}

export type CodingAgent = "claude" | "codex";

export interface CodingAgentCall {
  agent: CodingAgent;
  argv: string[];
  cwd: string;
  stdin: string;
  entry?: CliMockEntry;
}

export interface WaitForCallOptions {
  predicate: (call: CodingAgentCall) => boolean;
  /** Optional predicate; matching calls reject the wait with `rejectMessage`. */
  rejectOn?: (call: CodingAgentCall) => boolean;
  rejectMessage?: (call: CodingAgentCall) => string;
  timeoutMs: number;
}

export interface CodingAgentMockHandle {
  codingAgentCalls: CodingAgentCall[];
  selectedAgent: CodingAgent;
  /** Resolves on the next captured coding-agent call satisfying `predicate`. */
  waitForCall: (options: WaitForCallOptions) => Promise<CodingAgentCall>;
  queueCodexResponse: (variant: CodexResponseVariant) => void;
}

export interface SetupCodingAgentMockOptions {
  /** Override the result returned when the prompt is not a coding-protocol or worktree-creation call. */
  defaultResult?: string;
  /**
   * Delay (ms) before the stream-json (alcode) branch emits its NDJSON. alcode runs its child in
   * the foreground and blocks on it, so this delay is what makes the whole alcode exec long enough
   * for OpenClaw to background it (and the agent to post a "started" ack) before it exits and the
   * completion wake fires. Default 30000.
   */
  streamDelayMs?: number;
  /**
   * Consulted for every wrapper prompt before the built-in branches. A string
   * short-circuits the built-ins (no mock commit side effect); `undefined`
   * falls through. A delegation is not always protocol-shaped — a new-project
   * bootstrap has no repo to run a protocol in — so the hook sees them all.
   */
  onPrompt?: (ctx: ScenarioContext, cwd: string, prompt: string) => Promise<string | undefined>;
}

/**
 * Register both coding-agent mocks, record every invocation, and return protocol-shaped responses.
 */
export function setupCodingAgentMock(
  ctx: ScenarioContext,
  options: SetupCodingAgentMockOptions = {},
): CodingAgentMockHandle {
  const defaultResult = options.defaultResult ?? GENERIC_CODING_RESULT;
  // A real run lasts minutes: a status check right after the launch must still see it running,
  // so the launch turn ends on its ack and the completion wake reaches the same thread.
  const streamDelayMs = options.streamDelayMs ?? 30_000;
  const codingAgentCalls: CodingAgentCall[] = [];
  const selectedAgent = readConfiguredAgent();
  const codexResponses: CodexResponseVariant[] = [];
  type Watcher = {
    options: WaitForCallOptions;
    resolve: (c: CodingAgentCall) => void;
    reject: (err: Error) => void;
  };
  const watchers: Watcher[] = [];
  const finalizedCalls = new WeakSet<CodingAgentCall>();

  for (const agent of ["claude", "codex"] as const) {
    ctx.mockCli(agent, async ({ argv, cwd, stdin, stdout, stderr }) => {
      const call: CodingAgentCall = { agent, argv, cwd, stdin: await text(stdin) };
      codingAgentCalls.push(call);
      try {
        if (agent === "codex" && isCodexCatalogCall(call)) {
          stdout.write(`${JSON.stringify(CODEX_MODEL_CATALOG)}\n`);
          return 0;
        }
        const prompt = extractCodingPrompt(call);
        if (agent === "claude" && (argv[0] === "--version" || argv[0] === "-v")) {
          stdout.write("2.0.0 (Claude Code)\n");
          return 0;
        }
        if (agent === "claude" && (argv[0] === "--help" || argv[0] === "-h")) {
          stdout.write(
            "Usage: claude <prompt> [-p] [--output-format json] [--permission-mode <mode>]\n",
          );
          return 0;
        }
        if (prompt === undefined || !isAlignfirstWrapperCall(call)) {
          stderr.write(
            `mock-coding-agent: malformed ${agent} invocation: ${JSON.stringify(argv)}\n`,
          );
          return 1;
        }
        const hooked = await options.onPrompt?.(ctx, cwd, prompt);
        const pushResult =
          hooked === undefined && !isCodingProtocolPrompt(prompt)
            ? await pushMockFixtureBranch(ctx, cwd, prompt)
            : undefined;
        let resultText: string;
        if (hooked !== undefined) {
          resultText = hooked;
        } else if (isCodingProtocolPrompt(prompt)) {
          resultText = codingResultFor(prompt);
          await commitMockCodingChange(ctx, cwd, prompt, stderr);
          const published = await pushMockFixtureBranch(ctx, cwd, prompt);
          if (published !== undefined) resultText += ` ${published}`;
        } else if (pushResult !== undefined) {
          resultText = pushResult;
        } else if (isLogReviewPrompt(prompt)) {
          resultText = LOG_REVIEW_RESULT;
        } else if (VERIFICATION_INTENT_RE.test(prompt)) {
          resultText = verificationResultFor(prompt);
        } else if (looksLikeWorktreeList(prompt)) {
          const projectPath = resolveProjectPath(prompt, cwd);
          if (!projectPath) {
            stderr.write(
              "mock-coding-agent: could not resolve project for worktree list.\n" +
                `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
            );
            return 1;
          }
          const exec = await ctx.execInGateway(
            ["pnpm", "--dir", projectPath, "workspace", "list"],
            { timeoutMs: 30_000 },
          );
          if (exec.exitCode !== 0) {
            stderr.write(
              `mock-coding-agent: pnpm workspace list failed (exit ${exec.exitCode}).\n` +
                `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
            );
            return exec.exitCode;
          }
          resultText =
            exec.stdout.trim() || `No worktrees registered for ${basename(projectPath)}.`;
        } else if (looksLikeWorktreeAttach(prompt)) {
          const parsed = parseWorktreeRequest(prompt, cwd);
          if (!parsed) {
            stderr.write(
              "mock-coding-agent: could not resolve project+branch for worktree attach.\n" +
                `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
            );
            return 1;
          }
          const exec = await ctx.execInGateway(
            ["pnpm", "--dir", parsed.projectPath, "workspace", "setup", parsed.branch],
            { timeoutMs: 120_000 },
          );
          if (exec.exitCode !== 0) {
            stderr.write(
              `mock-coding-agent: pnpm workspace setup ${parsed.branch} failed (exit ${exec.exitCode}).\n` +
                `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
            );
            return exec.exitCode;
          }
          resultText =
            exec.stdout.trim() ||
            `Worktree attached to ${parsed.branch} on ${basename(parsed.projectPath)}.`;
        } else if (looksLikeWorktreeCreation(prompt)) {
          const parsed = parseWorktreeRequest(prompt, cwd);
          if (!parsed) {
            stderr.write(
              "mock-coding-agent: could not resolve project+branch for worktree creation.\n" +
                `cwd=${cwd}\nprompt(first 200 chars)=${prompt.slice(0, 200)}\n`,
            );
            return 1;
          }
          const exec = await ctx.execInGateway(
            ["pnpm", "--dir", parsed.projectPath, "workspace", "setup", parsed.branch, "-c"],
            { timeoutMs: 120_000 },
          );
          if (exec.exitCode !== 0) {
            stderr.write(
              `mock-coding-agent: pnpm workspace setup ${parsed.branch} -c failed (exit ${exec.exitCode}).\n` +
                `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
            );
            return exec.exitCode;
          }
          resultText =
            exec.stdout.trim() ||
            `Worktree ${parsed.branch} ready for ${basename(parsed.projectPath)}.`;
        } else {
          resultText = defaultResult;
        }
        await delay(streamDelayMs);
        const sessionId = resumeSessionId(call) ?? nextStreamSessionId();
        if (agent === "claude") {
          stdout.write(buildClaudeStreamResponse(sessionId, resultText));
        } else {
          const response = buildCodexStreamResponse(
            sessionId,
            resultText,
            codexResponses.shift() ?? "success",
          );
          stdout.write(response.stdout);
          if (response.stderr !== undefined) stderr.write(response.stderr);
          return response.exitCode;
        }
        return 0;
      } finally {
        // The mock-cli server emits the cliMock entry after the handler returns. Defer finalization
        // by one macrotask so every exit path can attach that entry before notifying watchers.
        setImmediate(() => finalizeCall(call));
      }
    });
  }

  function finalizeCall(call: CodingAgentCall): void {
    if (ctx.currentEntry?.kind === "cliMock") call.entry = ctx.currentEntry;
    finalizedCalls.add(call);
    const pending = watchers.splice(0, watchers.length);
    for (const w of pending) {
      if (w.options.rejectOn?.(call)) {
        const msg =
          w.options.rejectMessage?.(call) ??
          `unexpected coding-agent call: ${JSON.stringify(call.argv)}`;
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

  const waitForCall = (options: WaitForCallOptions): Promise<CodingAgentCall> => {
    const rejected = codingAgentCalls.find(
      (call) => finalizedCalls.has(call) && options.rejectOn?.(call),
    );
    if (rejected !== undefined) {
      const message =
        options.rejectMessage?.(rejected) ??
        `unexpected coding-agent call: ${JSON.stringify(rejected.argv)}`;
      return Promise.reject(new Error(message));
    }
    const existing = codingAgentCalls.find((c) => finalizedCalls.has(c) && options.predicate(c));
    if (existing) return Promise.resolve(existing);
    return new Promise<CodingAgentCall>((resolve, reject) => {
      const watcher: Watcher = { options, resolve, reject };
      watchers.push(watcher);
      setTimeout(() => {
        const idx = watchers.indexOf(watcher);
        if (idx !== -1) {
          watchers.splice(idx, 1);
          reject(new Error(`no matching coding-agent CLI call within ${options.timeoutMs}ms`));
        }
      }, options.timeoutMs);
    });
  };

  return {
    codingAgentCalls,
    selectedAgent,
    waitForCall,
    queueCodexResponse: (variant) => codexResponses.push(variant),
  };
}

export function isLogReviewPrompt(prompt: string): boolean {
  return LOG_REVIEW_INTENT_RE.test(prompt);
}

function readConfiguredAgent(): CodingAgent {
  const agent = process.env.ALIGNFIRST_CODE_AGENT;
  if (agent === "claude" || agent === "codex") return agent;
  throw new Error("ALIGNFIRST_CODE_AGENT must be set to claude or codex for playbook scenarios");
}

/**
 * True iff the call has the argv shape alcode emits for the call's agent.
 */
export function isAlignfirstWrapperCall(call: CodingAgentCall): boolean {
  const a = call.argv;
  if (call.agent === "codex") {
    return (
      a[0] === "exec" &&
      a[1] === "--json" &&
      a.at(-1) === "-" &&
      (hasAdjacentArgs(a, "--sandbox", "workspace-write") ||
        a.includes("--dangerously-bypass-approvals-and-sandbox"))
    );
  }
  return (
    a[0] === "-p" &&
    a[1] === "--output-format" &&
    a[2] === "stream-json" &&
    a[3] === "--verbose" &&
    (hasAdjacentArgs(a, "--permission-mode", "auto") ||
      a.includes("--dangerously-skip-permissions"))
  );
}

export function isCodexCatalogCall(call: CodingAgentCall): boolean {
  return (
    call.agent === "codex" &&
    call.argv.length === 3 &&
    call.argv[0] === "debug" &&
    call.argv[1] === "models" &&
    call.argv[2] === "--bundled"
  );
}

export function extractCodingPrompt(call: CodingAgentCall): string | undefined {
  if (!isAlignfirstWrapperCall(call)) return;
  return call.stdin;
}

function resumeSessionId(call: CodingAgentCall): string | undefined {
  if (call.agent === "claude") {
    const index = call.argv.indexOf("--resume");
    return index === -1 ? undefined : call.argv[index + 1];
  }
  const index = call.argv.indexOf("resume");
  return index === -1 ? undefined : call.argv[index + 1];
}

function hasAdjacentArgs(argv: string[], first: string, second: string): boolean {
  const index = argv.indexOf(first);
  return index !== -1 && argv[index + 1] === second;
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

function resolveProjectPath(prompt: string, cwd: string): string | undefined {
  const normalizedCwd = cwd.replace(/\/$/, "");
  const cwdProject = FIXTURE_PROJECT_PATHS.find((projectPath) => projectPath === normalizedCwd);
  if (cwdProject !== undefined) return cwdProject;
  const promptProject = prompt.match(FIXTURE_PROJECT_RE);
  if (promptProject === null) return;
  const name = promptProject[0].toLowerCase();
  return FIXTURE_PROJECT_PATHS.find((projectPath) => basename(projectPath) === name);
}

function parseWorktreeRequest(
  prompt: string,
  cwd: string,
): { projectPath: string; branch: string } | undefined {
  const branchMatch = prompt.match(BRANCH_TOKEN_RE);
  if (!branchMatch) return undefined;
  const branch = `${branchMatch[1]}/${branchMatch[2]}`;
  const projectPath = resolveProjectPath(prompt, cwd);
  if (!projectPath) return;
  return { projectPath, branch };
}

const CODING_PROTOCOL_RE =
  /^Run `alignfirst guide (spec|plan|aad|description|review|merge)` and follow the protocol\./;

// The edit each coding result stands behind, applied to the fixture's
// `home-page.mjs` with `sed`. A run reports "changes committed on the ticket
// branch", and the agent is told to verify a completed run — so the claim has
// to hold up: the change must be in the worktree, committed, and be the change
// the result describes. Each edit is idempotent, like a real coding agent's: a
// repeated tooltip run — the agent asked for a "fix" after checking a dev server
// started before the commit — left two, three, then four `title` attributes and
// the agent never declared the work done (A12 Slack, artifacts 2026-09-11T15-13-47).
const BOLD_BUTTON_EDIT = "s/font-weight: normal/font-weight: bold/";
const TOOLTIP_EDIT = `/title="Exporter les données"/! s|<button id="export-button"|<button id="export-button" title="Exporter les données"|`;
const GENERIC_EDIT =
  "/<!-- updated -->/! s|<h1>Comparables</h1>|<h1>Comparables</h1><!-- updated -->|";

function codingEditFor(prompt: string): string {
  if (TOOLTIP_INTENT_RE.test(prompt)) return TOOLTIP_EDIT;
  if (BOLD_INTENT_RE.test(prompt)) return BOLD_BUTTON_EDIT;
  return GENERIC_EDIT;
}

/**
 * Apply and commit the change the result claims. Only linked worktrees are
 * touched — a coding protocol always runs in one, and committing in a project's
 * main dir would corrupt the shared fixture.
 */
async function commitMockCodingChange(
  ctx: ScenarioContext,
  cwd: string | undefined,
  prompt: string,
  stderr: { write(chunk: string): void },
): Promise<void> {
  if (cwd === undefined || !isFixtureWorktreePath(cwd)) return;
  const exec = await ctx.execInGateway(
    [
      "sh",
      "-c",
      `cd "${cwd}" && sed -i '${codingEditFor(prompt)}' home-page.mjs && ` +
        "git add home-page.mjs && (git diff --cached --quiet || " +
        `git -c user.email=mock@local -c user.name=mock commit -q -m 'feat: apply the requested change')`,
    ],
    { timeoutMs: 30_000 },
  );
  if (exec.exitCode !== 0) {
    stderr.write(
      `mock-coding-agent: commit in ${cwd} failed (exit ${exec.exitCode}).\n` +
        `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}\n`,
    );
  }
}

export interface PushFixtureContext extends Pick<ScenarioContext, "execInGateway"> {}

export async function pushMockFixtureBranch(
  ctx: PushFixtureContext,
  cwd: string,
  prompt: string,
): Promise<string | undefined> {
  const instruction = prompt.split("\n\n## Current instruction\n\n").at(-1);
  if (instruction === undefined || !requestsFixturePush(instruction)) return;
  const projectPath = fixtureProjectForWorktree(cwd);
  if (projectPath === undefined) {
    throw new Error(`mock-coding-agent: refusing to push outside a fixture worktree: ${cwd}`);
  }
  const commonDir = await runFixtureGit(ctx, cwd, ["rev-parse", "--git-common-dir"]);
  if (commonDir !== `${projectPath}/.git`) {
    throw new Error(`mock-coding-agent: unexpected fixture Git directory: ${commonDir}`);
  }
  const origin = await runFixtureGit(ctx, cwd, ["remote", "get-url", "--push", "origin"]);
  const expectedOrigin = `/home/claw/.fixture-origins/${basename(projectPath)}.git`;
  if (origin !== expectedOrigin) {
    throw new Error(`mock-coding-agent: refusing to push to non-fixture origin: ${origin}`);
  }
  const branch = await runFixtureGit(ctx, cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!/^(?:ABC-\d+|side-\d+)\/.+/u.test(branch)) {
    throw new Error(`mock-coding-agent: refusing to push non-ticket branch: ${branch}`);
  }
  await runFixtureGit(ctx, cwd, ["push", "--set-upstream", "origin", "HEAD"]);
  return `Published the existing commit on ${branch} to origin; upstream tracking is configured.`;
}

function requestsFixturePush(instruction: string): boolean {
  if (PUSH_PROHIBITION_RE.test(instruction)) return false;
  return instruction
    .split(/\r?\n+|(?<=[.!?])\s+/u)
    .some((sentence) => !PUSH_REFERENCE_RE.test(sentence) && PUSH_REQUEST_RE.test(sentence));
}

async function runFixtureGit(
  ctx: PushFixtureContext,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await ctx.execInGateway(["git", "-C", cwd, ...args], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `mock-coding-agent: git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function fixtureProjectForWorktree(path: string): string | undefined {
  const normalizedPath = path.replace(/\/$/, "");
  return FIXTURE_PROJECT_PATHS.find((projectPath) => {
    const prefix = `${basename(projectPath)}-`;
    return (
      dirname(normalizedPath) === dirname(projectPath) &&
      basename(normalizedPath).startsWith(prefix)
    );
  });
}

function isFixtureWorktreePath(path: string): boolean {
  return fixtureProjectForWorktree(path) !== undefined;
}

/** Recognize the active instruction after optional catchup history. */
export function isCodingProtocolPrompt(prompt: string | undefined): boolean {
  if (prompt === undefined) return false;
  const instruction = prompt.split("\n\n## Current instruction\n\n").at(-1);
  return instruction !== undefined && CODING_PROTOCOL_RE.test(instruction);
}

/** Render a captured coding-agent invocation as a single text blob for the judge. */
export function renderCodingAgentCall(call: CodingAgentCall): string {
  return [
    `agent: ${call.agent}`,
    `cwd: ${call.cwd}`,
    `argv: ${JSON.stringify(call.argv)}`,
    `stdin: ${call.stdin}`,
  ].join("\n");
}

export interface ExpectNoProtocolDelegationOptions {
  rubric: string;
  label: string;
  /** Optional extra predicate, such as a project working-directory filter. */
  matches?: (call: CodingAgentCall) => boolean;
  timeoutMs?: number;
}

export interface NoProtocolDelegationResult {
  call: CodingAgentCall;
  /**
   * Bus cursor captured the instant the delegation is detected, before the
   * judge runs. The judge is a multi-second Anthropic round-trip; the agent
   * posts its summary right after the coding-agent mock returns, so a cursor taken
   * after the judge lands past the summary and strands it.
   */
  cursorAfterDelegation: number;
}

export async function expectNoProtocolDelegation(
  ctx: ScenarioContext,
  handle: CodingAgentMockHandle,
  // 180s: slower providers (glm-5.2) burn many short turns before delegating —
  // a valid call landed 3s past a 90s deadline (A03, artifacts 2026-07-28T09-01-38).
  { rubric, label, matches, timeoutMs = 180_000 }: ExpectNoProtocolDelegationOptions,
): Promise<NoProtocolDelegationResult> {
  const codingAgentCall = await handle.waitForCall({
    predicate: (call) =>
      call.agent === handle.selectedAgent &&
      isAlignfirstWrapperCall(call) &&
      !isCodingProtocolPrompt(extractCodingPrompt(call)) &&
      (matches?.(call) ?? true),
    rejectOn: (call) =>
      !isCodexCatalogCall(call) &&
      (!isAlignfirstWrapperCall(call) ||
        call.agent !== handle.selectedAgent ||
        (isCodingProtocolPrompt(extractCodingPrompt(call)) && (matches?.(call) ?? true))),
    rejectMessage: (call) =>
      "unexpected coding-agent call while awaiting no-protocol delegation: " +
      `agent=${call.agent} argv=${JSON.stringify(call.argv)}`,
    timeoutMs,
  });
  const cursorAfterDelegation = await ctx.getCursor();

  const target = codingAgentCall.entry;
  if (!target) {
    throw new Error("could not locate cliMock entry for coding-agent no-protocol delegation");
  }
  ctx.log({
    attachTo: target,
    label: "coding-agent no-protocol delegation call captured",
    extra: { promptLength: codingAgentCall.stdin.length },
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderCodingAgentCall(codingAgentCall),
    rubric,
    label,
  });

  return { call: codingAgentCall, cursorAfterDelegation };
}

export interface ExpectCodingDelegationOptions {
  ticketId: string;
  /** Optional extra predicate, e.g. project-name filter for multi-project. */
  matches?: (call: CodingAgentCall) => boolean;
  /** Override the default export-button task rubric. */
  rubric?: string;
  timeoutMs?: number;
  label?: string;
}

export async function expectCodingDelegation(
  ctx: ScenarioContext,
  handle: CodingAgentMockHandle,
  options: ExpectCodingDelegationOptions,
): Promise<CodingAgentCall> {
  const {
    ticketId,
    matches,
    rubric = defaultCodingDelegationRubric(ticketId),
    timeoutMs = 180_000,
    label = "coding-agent-delegation",
  } = options;
  const codingAgentCall = await handle.waitForCall({
    predicate: (call) =>
      call.agent === handle.selectedAgent &&
      isAlignfirstWrapperCall(call) &&
      isCodingProtocolPrompt(extractCodingPrompt(call)) &&
      (matches?.(call) ?? true),
    rejectOn: (call) =>
      !isCodexCatalogCall(call) &&
      (!isAlignfirstWrapperCall(call) || call.agent !== handle.selectedAgent),
    rejectMessage: (call) =>
      `unexpected non-wrapper coding-agent call: agent=${call.agent} argv=${JSON.stringify(call.argv)}`,
    timeoutMs,
  });

  const target = codingAgentCall.entry;
  if (!target) {
    throw new Error("could not locate cliMock entry for coding-agent delegation");
  }
  ctx.log({
    attachTo: target,
    label: "coding-agent delegation call captured",
    extra: { promptLength: codingAgentCall.stdin.length },
  });

  await ctx.judgeLLM({
    attachTo: target,
    message: renderCodingAgentCall(codingAgentCall),
    rubric,
    label,
  });

  return codingAgentCall;
}

function defaultCodingDelegationRubric(ticketId: string): string {
  return `The message is a prompt sent to a coding agent via the \`alcode\` CLI. Expected: an AlignFirst protocol invocation — \`Run \`alignfirst guide spec\` and follow the protocol. Ticket ID = …\`, or the equivalent with another lowercase protocol name — including ticket id ${ticketId} and a description of the actual task: making the export button bold (paraphrases of "passer le bouton d'export en gras" are fine). Reject if: the ticket id is missing or wrong, the task description is missing or unrelated, or the prompt does not look like an AlignFirst protocol invocation.`;
}
