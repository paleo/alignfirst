import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import type { Output } from "../output.js";
import { HARNESS_ENVIRONMENTS } from "./harness-environment.js";
import {
  appendTranscript,
  applyCompletion,
  type CompletionUpdate,
  formatResults,
} from "./session-file.js";

const TERMINATION_GRACE_MS = 2000;

// Every harness's session identity, and the assistant's harness request: the agent starts its own
// session, so it inherits none of them.
const SESSION_IDENTITY_VARIABLES = [
  ...Object.values(HARNESS_ENVIRONMENTS).flatMap(({ markers, sessionVariables }) => [
    ...markers.map((marker) => marker.name),
    ...sessionVariables,
  ]),
  "ALIGNDEV_ASSISTANT_HARNESS",
];

export interface RunConfig {
  prompt: string;
  sessionFilePath: string;
  nativeContext?: string;
  cwd: string;
  resume?: string;
  quiet?: boolean;
  executableModel: string | undefined;
  effort: string | undefined;
  skipPermissions: boolean;
  // Writable directories besides the working directory, e.g. the project's companion.
  additionalDirectories: readonly string[];
  // Finalized by profile resolution; discovery, state and spawn share this exact object.
  env: NodeJS.ProcessEnv;
}

export interface RunResult {
  status: "succeeded" | "failed";
  authRequired: boolean;
  sessionId: string | null;
  result: string;
}

export interface AgentProtocolState {
  sessionId?: string;
  result?: string;
  // A response boundary, independent of run settlement; excludes partial/tool commentary.
  resultComplete?: boolean;
  // Completed responses superseded by a later one, oldest first. The Result block keeps them all.
  earlierResults: string[];
  failure?: string;
  protocolComplete: boolean;
  protocolFailed: boolean;
  authEvidence: boolean;
  // Context-window occupancy reported by the newest model response seen so far. Each adapter
  // overwrites it, so the last write is the run's final context size.
  contextTokens?: number;
  // Highest occupancy seen during the run. Above the final figure, it means the agent compacted
  // the conversation.
  peakContextTokens?: number;
  // Explicit adapter evidence takes precedence over the legacy peak-decrease heuristic.
  contextCompacted?: boolean;
  contextTokensError?: string;
  // Codex only: the cumulative thread total from `turn.completed`, used to pin the rollout file to
  // this run. It is not an occupancy.
  streamTotalTokens?: number;
  expectedSessionId?: string;
  identityFailure?: string;
  nativeEnv?: NodeJS.ProcessEnv;
}

export interface AgentAssessment {
  succeeded: boolean;
  sessionId?: string;
  result?: string;
  error?: string;
  authEvidence: boolean;
  contextTokens?: number;
  contextCompacted?: boolean;
  contextTokensError?: string;
}

export interface AgentAdapter {
  executable: string;
  // Set for every run, over the caller's environment.
  env?: Readonly<Record<string, string>>;
  buildArgs(config: RunConfig): string[];
  createState(config: RunConfig): AgentProtocolState;
  interpretLine(line: string, state: AgentProtocolState): string | undefined;
  assess(state: AgentProtocolState): AgentAssessment;
  isAuthenticationError(message: string): boolean;
  authenticationMessage(detail?: string): string;
  failureMessage?(state: AgentProtocolState): string;
  // Builds the child's stdin from the prompt. Absent: the prompt is sent as is.
  formatInput?(config: RunConfig): string;
}

export type SpawnAgentProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcess;

export async function runAgent(
  config: RunConfig,
  adapter: AgentAdapter,
  out: Output,
  spawnProcess: SpawnAgentProcess = spawnDirectChild,
): Promise<RunResult> {
  const state = adapter.createState(config);
  const outcome = await spawnAgent(config, adapter, state, out, spawnProcess);
  const assessment = adapter.assess(state);
  const failed = outcome.exitCode !== 0 || !assessment.succeeded;
  // Authentication evidence matters only when the run failed. Claude can recover after retrying
  // a 401, so evidence from a successful run must not produce an auth_required result.
  const authRequired =
    failed && (assessment.authEvidence || adapter.isAuthenticationError(outcome.stderr));
  const selectedResult = selectResult(adapter, state, assessment, outcome, authRequired);
  const result =
    failed && config.nativeContext !== undefined
      ? `${config.nativeContext}: ${selectedResult}`
      : selectedResult;
  // Durable identity belongs to the requested conversation, even when native validation fails.
  const sessionId = config.resume ?? assessment.sessionId ?? null;
  applyCompletion(config.sessionFilePath, {
    status: failed ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    exitReason: authRequired ? "auth_required" : failed ? "error" : "completed",
    sessionId,
    result: formatResults(state.earlierResults, result),
    contextTokens: assessment.contextTokens ?? null,
    contextCompacted: assessment.contextCompacted ?? false,
    contextTokensError: assessment.contextTokensError ?? null,
  });
  return {
    status: failed ? "failed" : "succeeded",
    authRequired,
    sessionId,
    result,
  };
}

function spawnDirectChild(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
): ChildProcess {
  return spawn(command, args, options);
}

interface ProcessOutcome {
  exitCode: number | null;
  stderr: string;
}

function selectResult(
  adapter: AgentAdapter,
  state: AgentProtocolState,
  assessment: AgentAssessment,
  outcome: ProcessOutcome,
  authRequired: boolean,
): string {
  if (authRequired) {
    return adapter.authenticationMessage(assessment.error ?? nonblank(outcome.stderr));
  }
  if (assessment.succeeded && outcome.exitCode === 0 && assessment.result !== undefined) {
    return assessment.result;
  }
  return (
    assessment.error ??
    nonblank(outcome.stderr) ??
    (!assessment.succeeded ? adapter.failureMessage?.(state) : undefined) ??
    `${adapter.executable} exited with code ${outcome.exitCode ?? "unknown"}`
  );
}

function spawnAgent(
  config: RunConfig,
  adapter: AgentAdapter,
  state: AgentProtocolState,
  out: Output,
  spawnProcess: SpawnAgentProcess,
): Promise<ProcessOutcome> {
  const child = spawnProcess(adapter.executable, adapter.buildArgs(config), {
    cwd: config.cwd,
    env: config.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const detachChildGuards = guardChildLifecycle(child, config.sessionFilePath, state);
  let buffer = "";
  let stderr = "";
  let inputError: Error | undefined;
  let identityStopTimer: NodeJS.Timeout | undefined;
  // A changed or missing identity is permanent: the rest of the run would work in another
  // conversation.
  const interpretLine = (line: string) => {
    emitLine(config, adapter, line, state, out);
    if (state.identityFailure !== undefined && identityStopTimer === undefined) {
      identityStopTimer = stopChild(child);
    }
  };
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    buffer = drainLines(buffer, interpretLine);
  });
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(identityStopTimer);
      detachChildGuards();
      resolve(outcome);
    };
    child.on("close", (code) => {
      if (buffer.trim() !== "") emitLine(config, adapter, buffer, state, out);
      finish({
        exitCode: inputError === undefined ? code : 1,
        stderr:
          inputError === undefined
            ? stderr
            : `${stderr}\nCould not send prompt: ${inputError.message}`,
      });
    });
    child.on("error", (err) => finish({ exitCode: 1, stderr: err.message }));
    child.stdin?.on("error", (error: Error) => {
      inputError = error;
      child.kill("SIGTERM");
    });
    child.stdin?.end(adapter.formatInput?.(config) ?? config.prompt, "utf8");
  });
}

function emitLine(
  config: RunConfig,
  adapter: AgentAdapter,
  line: string,
  state: AgentProtocolState,
  out: Output,
): void {
  const rendered = adapter.interpretLine(line, state);
  if (rendered === undefined) return;
  appendTranscript(config.sessionFilePath, `${rendered}\n`);
  if (config.quiet !== true) out.write(`${rendered}\n`);
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() !== "") onLine(line);
  }
  return rest;
}

export function captureNativeSession(state: AgentProtocolState, id: unknown, agent: string): void {
  if (typeof id !== "string" || id.trim() === "") {
    state.identityFailure ??= `${agent} stream reported no native session identity.`;
    return;
  }
  const expected = state.expectedSessionId ?? state.sessionId;
  if (expected !== undefined && id !== expected) {
    state.identityFailure ??= `${agent} resumed/native session identity changed; the conversation may be unavailable in the selected native configuration. Start a new session or select the correct profile.`;
    return;
  }
  state.sessionId = id;
}

export function buildAgentEnv(
  baseEnv: NodeJS.ProcessEnv,
  unset: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
  required: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const inherited = externalProcessBaseline(baseEnv);
  for (const name of unset) delete inherited[name];
  const env = { ...inherited, ...overrides };
  for (const name of SESSION_IDENTITY_VARIABLES) delete env[name];
  return { ...env, ...required };
}

// Removes what a package launcher (npm, npx, a Bun runner) injected into the caller environment.
function externalProcessBaseline(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (env.NODE !== undefined && env.NODE === env.npm_node_execpath) delete env.NODE;
  removeBunShims(env);
  for (const name of Object.keys(env)) if (name.startsWith("npm_")) delete env[name];
  delete env.INIT_CWD;
  if (env.PATH !== undefined) env.PATH = withoutLeadingLauncherBins(env.PATH);
  return env;
}

function removeBunShims(env: NodeJS.ProcessEnv): void {
  if (env.PATH === undefined) return;
  const entries = env.PATH.split(delimiter);
  const shims = new Set(entries.filter(isBunRuntimeShim));
  if (shims.size === 0) return;
  env.PATH = entries.filter((entry) => !shims.has(entry)).join(delimiter);
  for (const name of ["NODE", "npm_node_execpath"]) {
    const value = env[name];
    if (value !== undefined && shims.has(value)) delete env[name];
  }
}

// npm prepends the package bin directories, then its node-gyp shim directory, to PATH.
function withoutLeadingLauncherBins(path: string): string {
  const entries = path.split(delimiter);
  const first = entries.findIndex((entry) => !isLauncherBin(entry));
  return (first === -1 ? [] : entries.slice(first)).join(delimiter);
}

function isLauncherBin(entry: string): boolean {
  const directory = entry.replace(/[\\/]+$/, "");
  return (
    basename(directory) === "node-gyp-bin" || /(?:^|[\\/])node_modules[\\/]\.bin$/.test(directory)
  );
}

function isBunRuntimeShim(directory: string): boolean {
  // Forced Bun runners inject a dedicated node/bun symlink pair. A Bun installation or
  // a directory name alone does not establish a launcher override.
  if (!/^bun-node-(?:\d+-)?[a-f0-9]+$/.test(basename(directory))) return false;
  const extension = process.platform === "win32" ? ".exe" : "";
  const node = join(directory, `node${extension}`);
  const bun = join(directory, `bun${extension}`);
  try {
    if (!lstatSync(node).isSymbolicLink() || !lstatSync(bun).isSymbolicLink()) return false;
    const target = realpathSync(bun);
    return /^bunx?(?:\.exe)?$/.test(basename(target)) && realpathSync(node) === target;
  } catch {
    return false;
  }
}

function guardChildLifecycle(
  child: ChildProcess,
  sessionFilePath: string,
  state: AgentProtocolState,
): () => void {
  // Seal the session, ask the child to stop, then force-kill it after a short grace period so
  // interrupted runs leave neither a stale session record nor an orphaned child process.
  const forceKill = () => signalChild(child, "SIGKILL");
  const onSignal = async (signal: NodeJS.Signals) => {
    try {
      applyCompletion(sessionFilePath, buildTerminationUpdate(signal, state, new Date()));
    } catch {
      // Session sealing is best-effort when the file is missing or malformed.
    }
    signalChild(child, "SIGTERM");
    await waitForChildExit(child, TERMINATION_GRACE_MS);
    forceKill();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", forceKill);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", forceKill);
  };
}

// Asks the child to stop, then force-kills it after the grace period. Clear the returned timer
// once the child has closed.
function stopChild(child: ChildProcess): NodeJS.Timeout {
  signalChild(child, "SIGTERM");
  return setTimeout(() => signalChild(child, "SIGKILL"), TERMINATION_GRACE_MS);
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The child exited between the liveness check and the signal.
  }
}

function waitForChildExit(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, graceMs);
    child.once("exit", onExit);
  });
}

export function buildTerminationUpdate(
  signal: NodeJS.Signals,
  state: AgentProtocolState,
  now: Date,
): CompletionUpdate {
  return {
    status: "failed",
    endedAt: now.toISOString(),
    exitReason: "terminated",
    sessionId: state.expectedSessionId ?? state.sessionId ?? null,
    result: formatResults(
      state.resultComplete === true && state.result !== undefined
        ? [...state.earlierResults, state.result]
        : state.earlierResults,
      `Terminated by ${signal} before completion.`,
    ),
    contextTokens: state.contextTokens ?? null,
    contextCompacted: isCompacted(state),
    contextTokensError: state.contextTokensError ?? null,
  };
}

// Occupancy only falls when the agent compacts the conversation, so a peak above the final figure
// is the compaction itself.
export function isCompacted(state: AgentProtocolState): boolean {
  if (state.contextCompacted !== undefined) return state.contextCompacted;
  const { contextTokens, peakContextTokens } = state;
  if (contextTokens === undefined || peakContextTokens === undefined) return false;
  return peakContextTokens > contextTokens;
}

function nonblank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
