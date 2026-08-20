import { type ChildProcess, spawn } from "node:child_process";

import { appendTranscript, applyCompletion, type CompletionUpdate } from "./session-file.js";

const TERMINATION_GRACE_MS = 2000;

export interface RunConfig {
  prompt: string;
  sessionFilePath: string;
  cwd: string;
  isNew: boolean;
  resume?: string;
  model?: string;
  executableModel?: string;
  skipPermissions: boolean;
  unset: string[];
  env: NodeJS.ProcessEnv;
}

export interface RunOutput {
  write(text: string): void;
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
  failure?: string;
  protocolComplete: boolean;
  protocolFailed: boolean;
  authEvidence: boolean;
}

export interface AgentAssessment {
  succeeded: boolean;
  sessionId?: string;
  result?: string;
  error?: string;
  authEvidence: boolean;
}

export interface AgentAdapter {
  executable: string;
  buildArgs(config: RunConfig): string[];
  createState(): AgentProtocolState;
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
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export async function runAgent(
  config: RunConfig,
  adapter: AgentAdapter,
  out: RunOutput,
  spawnProcess: SpawnAgentProcess = spawnDirectChild,
): Promise<RunResult> {
  const state = adapter.createState();
  const outcome = await spawnAgent(config, adapter, state, out, spawnProcess);
  const assessment = adapter.assess(state);
  const failed = outcome.exitCode !== 0 || !assessment.succeeded;
  const authRequired =
    failed && (assessment.authEvidence || adapter.isAuthenticationError(outcome.stderr));
  const result = selectResult(adapter, state, assessment, outcome, authRequired);
  applyCompletion(config.sessionFilePath, {
    status: failed ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    exitReason: authRequired ? "auth_required" : failed ? "error" : "completed",
    sessionId: assessment.sessionId ?? null,
    result,
  });
  return {
    status: failed ? "failed" : "succeeded",
    authRequired,
    sessionId: assessment.sessionId ?? null,
    result,
  };
}

function spawnDirectChild(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
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
  out: RunOutput,
  spawnProcess: SpawnAgentProcess,
): Promise<ProcessOutcome> {
  const child = spawnProcess(adapter.executable, adapter.buildArgs(config), {
    cwd: config.cwd,
    env: buildAgentEnv(config.env, config.unset),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const detachChildGuards = guardChildLifecycle(child, config.sessionFilePath, state);
  let buffer = "";
  let stderr = "";
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
      finish({ exitCode: code, stderr });
    });
    child.on("error", (err) => finish({ exitCode: 1, stderr: err.message }));
  });
}

function emitLine(
  config: RunConfig,
  adapter: AgentAdapter,
  line: string,
  state: AgentProtocolState,
  out: RunOutput,
): void {
  const rendered = adapter.interpretLine(line, state);
  if (rendered === undefined) return;
  appendTranscript(config.sessionFilePath, `${rendered}\n`);
  out.write(`${rendered}\n`);
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() !== "") onLine(line);
  }
  return rest;
}

export function buildAgentEnv(baseEnv: NodeJS.ProcessEnv, unset: string[]): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const name of unset) {
    const trimmed = name.trim();
    if (trimmed !== "") delete env[trimmed];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("ALIGNFIRST_CODE_")) delete env[key];
  }
  return env;
}

function guardChildLifecycle(
  child: ChildProcess,
  sessionFilePath: string,
  state: AgentProtocolState,
): () => void {
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
    sessionId: state.sessionId ?? null,
    result: `Terminated by ${signal} before completion.`,
  };
}

function nonblank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
