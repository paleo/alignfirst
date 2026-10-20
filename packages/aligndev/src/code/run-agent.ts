import { type ChildProcess, spawn } from "node:child_process";

import type { Output } from "../output.js";
import {
  appendTranscript,
  applyCompletion,
  type CompletionUpdate,
  formatResults,
} from "./session-file.js";

const TERMINATION_GRACE_MS = 2000;

// A coding-agent session exports its own identity to every command it runs; when the assistant
// runs in one, the agent it launches must not inherit it.
const ASSISTANT_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

export interface RunConfig {
  prompt: string;
  sessionFilePath: string;
  nativeContext?: string;
  cwd: string;
  resume?: string;
  quiet?: boolean;
  executableModel: string | undefined;
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
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    buffer = drainLines(buffer, (line) => emitLine(config, adapter, line, state, out));
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
    child.stdin?.end(config.prompt, "utf8");
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
  const inherited = { ...baseEnv };
  for (const name of unset) delete inherited[name];
  const env = { ...inherited, ...overrides };
  for (const name of ASSISTANT_SESSION_VARIABLES) delete env[name];
  if (env.PI_CODING_AGENT === "true") delete env.PI_CODING_AGENT;
  if (env.AI_AGENT === "pi") delete env.AI_AGENT;
  return { ...env, ...required };
}

function guardChildLifecycle(
  child: ChildProcess,
  sessionFilePath: string,
  state: AgentProtocolState,
): () => void {
  // Seal the session, ask the child to stop, then force-kill it after a short grace period so
  // interrupted runs leave neither a stale session record nor an orphaned child process.
  const isAlive = () => child.exitCode === null && child.signalCode === null;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!isAlive()) return;
    try {
      child.kill(signal);
    } catch {
      // The child exited between the liveness check and the signal.
    }
  };
  const forceKill = () => signalChild("SIGKILL");
  const onSignal = async (signal: NodeJS.Signals) => {
    try {
      applyCompletion(sessionFilePath, buildTerminationUpdate(signal, state, new Date()));
    } catch {
      // Session sealing is best-effort when the file is missing or malformed.
    }
    signalChild("SIGTERM");
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
    result: formatResults(state.earlierResults, `Terminated by ${signal} before completion.`),
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
