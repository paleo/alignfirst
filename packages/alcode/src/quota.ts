import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { CodingAgent } from "./coding-agent.js";
import { buildAgentEnv } from "./run-agent.js";

const QUOTA_TIMEOUT_MS = 30_000;
const CLAUDE_PRIVACY_OPT_OUTS = [
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_BUG_COMMAND",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
] as const;
const execFileAsync = promisify(execFile);
const DEFAULT_QUOTA_PROCESS_ADAPTER: QuotaProcessAdapter = {
  execute: executeQuotaProcess,
  spawn: spawnQuotaProcess,
};

export const readQuota: QuotaReader = createQuotaReader();

export interface QuotaContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type QuotaReader = (agent: CodingAgent, context: QuotaContext) => Promise<string>;

export interface QuotaProcessAdapter {
  execute(
    file: string,
    args: string[],
    options: QuotaProcessOptions & { timeout: number },
  ): Promise<{ stdout: string }>;
  spawn(file: string, args: string[], options: QuotaProcessOptions): ChildProcessWithoutNullStreams;
}

interface QuotaProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitBucket {
  windows: RateLimitWindow[];
}

export function createQuotaReader(
  adapter: QuotaProcessAdapter = DEFAULT_QUOTA_PROCESS_ADAPTER,
  timeoutMs = QUOTA_TIMEOUT_MS,
): QuotaReader {
  return async (agent, context) => {
    const env = buildAgentEnv(context.env, (context.env.ALIGNFIRST_CODE_UNSET ?? "").split(","));
    return agent === "claude"
      ? readClaudeQuota({ ...context, env: translateClaudePrivacyOptOut(env) }, adapter, timeoutMs)
      : readCodexQuota({ ...context, env }, adapter, timeoutMs);
  };
}

function translateClaudePrivacyOptOut(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) return env;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  for (const name of CLAUDE_PRIVACY_OPT_OUTS) env[name] = "1";
  return env;
}

async function readClaudeQuota(
  context: QuotaContext,
  adapter: QuotaProcessAdapter,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await adapter.execute(
    "claude",
    ["-p", "/usage", "--tools", "", "--output-format", "json", "--no-session-persistence"],
    {
      cwd: context.cwd,
      env: context.env,
      timeout: timeoutMs,
    },
  );
  return `Claude Code quota\n\n${parseClaudeQuota(stdout)}`;
}

export function parseClaudeQuota(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Claude Code returned malformed usage JSON.");
  }
  if (!isRecord(value)) throw new Error("Claude Code returned an unexpected usage response.");
  const result = value.result;
  if (value.is_error === true || value.subtype !== "success" || typeof result !== "string") {
    throw new Error("Claude Code could not read the current usage limits.");
  }
  const insightsStart = result.search(/^What's contributing to your limits usage\?/m);
  const limits = (insightsStart === -1 ? result : result.slice(0, insightsStart)).trimEnd();
  if (!/\d+% used/.test(limits)) throw new Error("Claude Code returned no usage limits.");
  return limits;
}

async function readCodexQuota(
  context: QuotaContext,
  adapter: QuotaProcessAdapter,
  timeoutMs: number,
): Promise<string> {
  const response = await requestCodexQuota(context, adapter, timeoutMs);
  return formatCodexQuota(response);
}

function requestCodexQuota(
  context: QuotaContext,
  adapter: QuotaProcessAdapter,
  timeoutMs: number,
): Promise<unknown> {
  const child = adapter.spawn("codex", ["app-server"], {
    cwd: context.cwd,
    env: context.env,
  });
  return exchangeCodexMessages(child, timeoutMs);
}

function exchangeCodexMessages(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<unknown> {
  const detachGuard = guardChild(child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachGuard();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("Codex timed out while reading usage limits.")),
      timeoutMs,
    );
    const readStderr = observeCodexOutput(child, finish);
    observeCodexLifecycle(child, finish, () => settled, readStderr);
    initializeCodex(child);
  });
}

function guardChild(child: ChildProcessWithoutNullStreams): () => void {
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("exit", kill);
  return () => process.off("exit", kill);
}

function observeCodexOutput(
  child: ChildProcessWithoutNullStreams,
  finish: (error: Error | undefined, result?: unknown) => void,
): () => string {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    stdout = drainJsonLines(stdout, (message) => handleCodexMessage(child, message, finish));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return () => stderr;
}

function drainJsonLines(
  buffer: string,
  onMessage: (message: Record<string, unknown>) => void,
): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value)) onMessage(value);
  }
  return rest;
}

function handleCodexMessage(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
  finish: (error: Error | undefined, result?: unknown) => void,
): void {
  if (message.id === 0 && message.result !== undefined) {
    sendCodexMessage(child, { method: "initialized", params: {} });
    sendCodexMessage(child, { method: "account/rateLimits/read", id: 1 });
  }
  if (message.id !== 1) return;
  if (isRecord(message.error)) {
    const detail = message.error.message;
    finish(
      new Error(
        typeof detail === "string"
          ? `Codex could not read usage limits: ${detail}`
          : "Codex could not read the current usage limits.",
      ),
    );
    return;
  }
  finish(undefined, message.result);
}

function sendCodexMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function observeCodexLifecycle(
  child: ChildProcessWithoutNullStreams,
  finish: (error: Error | undefined) => void,
  isSettled: () => boolean,
  readStderr: () => string,
): void {
  child.stdin.on("error", (error) => {
    finish(new Error(`Codex could not read usage limits: ${error.message}`));
  });
  child.on("error", (error) => finish(error));
  child.on("close", (code) => {
    if (isSettled()) return;
    const detail = readStderr().trim();
    finish(
      new Error(
        detail !== ""
          ? `Codex could not read usage limits: ${detail}`
          : `Codex app-server exited with code ${code ?? "unknown"}.`,
      ),
    );
  });
}

function initializeCodex(child: ChildProcessWithoutNullStreams): void {
  sendCodexMessage(child, {
    method: "initialize",
    id: 0,
    params: {
      clientInfo: {
        name: "alcode",
        title: "AlignFirst alcode",
        version: "0.0.0",
      },
    },
  });
}

async function executeQuotaProcess(
  file: string,
  args: string[],
  options: QuotaProcessOptions & { timeout: number },
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(file, args, {
    ...options,
    encoding: "utf8",
  });
  return { stdout };
}

function spawnQuotaProcess(
  file: string,
  args: string[],
  options: QuotaProcessOptions,
): ChildProcessWithoutNullStreams {
  return spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

export function formatCodexQuota(
  response: unknown,
  formatTime: (timestampSeconds: number) => string = formatLocalTime,
): string {
  const bucket = parseCodexBucket(response);
  return `Codex quota\n\n${formatBucket(bucket, formatTime)}`;
}

function parseCodexBucket(response: unknown): RateLimitBucket {
  if (!isRecord(response)) throw new Error("Codex returned an unexpected usage response.");
  const bucket = parseBucket(response.rateLimits);
  if (bucket === undefined) {
    throw new Error("Codex returned no usage windows for the current account.");
  }
  return bucket;
}

function parseBucket(value: unknown): RateLimitBucket | undefined {
  if (!isRecord(value)) return;
  const windows = [parseWindow(value.primary), parseWindow(value.secondary)].filter(
    (window): window is RateLimitWindow => window !== undefined,
  );
  if (windows.length === 0) return;
  return { windows };
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  if (!isRecord(value) || typeof value.usedPercent !== "number") return;
  return {
    usedPercent: value.usedPercent,
    windowDurationMins:
      typeof value.windowDurationMins === "number" ? value.windowDurationMins : null,
    resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null,
  };
}

function formatBucket(
  bucket: RateLimitBucket,
  formatTime: (timestampSeconds: number) => string,
): string {
  const windows = bucket.windows.map((window, index) => {
    const duration = formatDuration(window.windowDurationMins, index);
    const reset = window.resetsAt === null ? "" : ` · resets ${formatTime(window.resetsAt)}`;
    return `  ${duration}: ${window.usedPercent}% used${reset}`;
  });
  return `Codex\n${windows.join("\n")}`;
}

function formatDuration(minutes: number | null, index: number): string {
  if (minutes === null) return index === 0 ? "Primary window" : "Secondary window";
  if (minutes % 10_080 === 0) return plural(minutes / 10_080, "week");
  if (minutes % 1_440 === 0) return plural(minutes / 1_440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function formatLocalTime(timestampSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestampSeconds * 1000),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
