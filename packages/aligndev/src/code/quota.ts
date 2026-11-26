import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { QuotaSource } from "../config.js";
import { CODING_AGENT_NAMES } from "./coding-agent.js";
import { runQuotaProcess } from "./quota-process.js";

const QUOTA_TIMEOUT_MS = 30_000;
const CLAUDE_PRIVACY_OPT_OUTS = [
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_BUG_COMMAND",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
] as const;
const AGY_WINDOW_LABELS: Readonly<Record<string, string>> = { weekly: "1 week", "5h": "5 hours" };
const DEFAULT_QUOTA_PROCESS_ADAPTER: QuotaProcessAdapter = {
  execute: executeQuotaProcess,
  spawn: spawnQuotaProcess,
};

export const readQuota: QuotaReader = createQuotaReader();

export interface QuotaContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type QuotaReader = (source: QuotaSource, context: QuotaContext) => Promise<string>;

export interface QuotaProcessAdapter {
  execute(file: string, args: string[], options: QuotaExecuteOptions): Promise<{ stdout: string }>;
  spawn(file: string, args: string[], options: QuotaProcessOptions): ChildProcessWithoutNullStreams;
}

interface QuotaProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface QuotaExecuteOptions extends QuotaProcessOptions {
  timeout: number;
  // The native CLI's display name, for diagnostics.
  source: string;
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
  return async (source, context) => {
    try {
      return await readSourceQuota(source, context, adapter, timeoutMs);
    } catch (error) {
      if (error instanceof Error && isSourceDiagnostic(error.message)) throw error;
      throw new Error(
        `${CODING_AGENT_NAMES[source]} quota command failed; ` +
          "check that the native CLI is installed and authenticated in the selected configuration.",
      );
    }
  };
}

// A source's own diagnostic names the native CLI.
function isSourceDiagnostic(message: string): boolean {
  return Object.values(CODING_AGENT_NAMES).some((name) => message.startsWith(`${name} `));
}

function readSourceQuota(
  source: QuotaSource,
  context: QuotaContext,
  adapter: QuotaProcessAdapter,
  timeoutMs: number,
): Promise<string> {
  switch (source) {
    case "claude":
      return readClaudeQuota(
        { ...context, env: translateClaudePrivacyOptOut({ ...context.env }) },
        adapter,
        timeoutMs,
      );
    case "codex":
      return readCodexQuota(context, adapter, timeoutMs);
    case "agy":
      return readAgyQuota(context, adapter, timeoutMs);
  }
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
      source: CODING_AGENT_NAMES.claude,
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
  let stdout = "";
  let initialized = false;
  let response: unknown;
  return runQuotaProcess<unknown>(child, {
    source: "Codex",
    timeoutMs,
    start: initializeCodex,
    stdout(chunk, write) {
      stdout = drainJsonLines(stdout + chunk, (message) => {
        if (response !== undefined) return;
        if (message.id === 0 && !initialized) {
          if (!isRecord(message.result) || message.error !== undefined)
            throw new Error(
              "Codex could not initialize quota reading; check native authentication.",
            );
          initialized = true;
          write({ method: "initialized", params: {} });
          write({ method: "account/rateLimits/read", id: 1 });
        }
        if (message.id !== 1) return;
        if (!initialized || !isRecord(message.result) || message.error !== undefined)
          throw new Error("Codex could not read usage limits; check native authentication.");
        response = message.result;
      });
      return response;
    },
  });
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
      throw new Error("Codex returned malformed quota JSON; check native CLI usage.");
    }
    if (!isRecord(value)) throw new Error("Codex returned an unexpected usage response.");
    onMessage(value);
  }
  return rest;
}

function initializeCodex(write: (message: unknown) => void): void {
  write({
    method: "initialize",
    id: 0,
    params: {
      clientInfo: {
        name: "aligndev",
        title: "AlignFirst aligndev",
        version: "0.0.0",
      },
    },
  });
}

async function executeQuotaProcess(
  file: string,
  args: string[],
  options: QuotaExecuteOptions,
): Promise<{ stdout: string }> {
  const child = spawnQuotaProcess(file, args, options);
  let stdout = "";
  const result = await runQuotaProcess<string>(child, {
    source: options.source,
    timeoutMs: options.timeout,
    stdout(chunk) {
      stdout += chunk;
    },
    close(code) {
      if (code !== 0)
        throw new Error(
          `${options.source} could not read usage limits; check native authentication.`,
        );
      return stdout;
    },
    start() {
      child.stdin.end();
    },
  });
  return { stdout: result };
}

function spawnQuotaProcess(
  file: string,
  args: string[],
  options: QuotaProcessOptions,
): ChildProcessWithoutNullStreams {
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readAgyQuota(
  context: QuotaContext,
  adapter: QuotaProcessAdapter,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await adapter.execute("agy", ["-p", "/usage", "--output-format", "json"], {
    cwd: context.cwd,
    env: context.env,
    timeout: timeoutMs,
    source: CODING_AGENT_NAMES.agy,
  });
  return formatAgyQuota(stdout);
}

export function formatAgyQuota(
  stdout: string,
  formatTime: (timestampSeconds: number) => string = formatLocalTime,
): string {
  const groups = parseAgyGroups(stdout)
    .map((group) => formatAgyGroup(group, formatTime))
    .filter((group) => group !== undefined);
  if (groups.length === 0) {
    throw new Error("Antigravity returned no usage limits for the current account.");
  }
  return `Antigravity quota\n\n${groups.join("\n")}`;
}

function parseAgyGroups(stdout: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Antigravity returned malformed usage JSON; check native CLI usage.");
  }
  const command = isRecord(value) ? value.command : undefined;
  const data = isRecord(command) ? command.data : undefined;
  const groups = isRecord(data) ? data.groups : undefined;
  if (!Array.isArray(groups)) throw new Error("Antigravity returned an unexpected usage response.");
  return groups;
}

// A group without any valid bucket is omitted.
function formatAgyGroup(
  group: unknown,
  formatTime: (timestampSeconds: number) => string,
): string | undefined {
  if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) return;
  const lines = group.buckets
    .map((bucket) => formatAgyBucket(bucket, formatTime))
    .filter((line) => line !== undefined);
  if (lines.length === 0) return;
  return `${group.name}\n${lines.join("\n")}`;
}

function formatAgyBucket(
  bucket: unknown,
  formatTime: (timestampSeconds: number) => string,
): string | undefined {
  if (!isRecord(bucket)) return;
  const remaining = bucket.remaining_fraction;
  if (!finiteNumber(remaining) || remaining < 0 || remaining > 1) return;
  const usedPercent = Math.round((1 - remaining) * 100);
  const window = typeof bucket.window === "string" ? bucket.window : "unknown window";
  const label = Object.hasOwn(AGY_WINDOW_LABELS, window) ? AGY_WINDOW_LABELS[window] : window;
  const resetMs =
    typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
  const reset = Number.isNaN(resetMs) ? "" : ` · resets ${formatTime(resetMs / 1000)}`;
  return `  ${label}: ${usedPercent}% used${reset}`;
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
  const named = response.rateLimitsByLimitId;
  const authoritative = isRecord(named) && Object.hasOwn(named, "codex");
  const value = authoritative ? named.codex : response.rateLimits;
  if (isRecord(value) && value.limitId != null && value.limitId !== "codex") {
    throw new Error("Codex returned a different limit bucket; expected the codex bucket.");
  }
  const bucket = parseBucket(value);
  if (bucket === undefined) {
    throw new Error(
      authoritative
        ? "Codex returned a malformed named codex snapshot with no usage windows; check native CLI usage."
        : "Codex returned no usage windows for the current account; check native CLI usage.",
    );
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
  if (!isRecord(value) || !finiteNumber(value.usedPercent)) return;
  if (value.usedPercent < 0 || value.usedPercent > 100) return;
  const duration = value.windowDurationMins;
  if (duration != null && (!finiteNumber(duration) || duration <= 0)) return;
  const reset = value.resetsAt;
  if (reset != null && (!finiteNumber(reset) || reset < 0 || reset > 8_640_000_000_000)) return;
  return {
    usedPercent: value.usedPercent,
    windowDurationMins: duration ?? null,
    resetsAt: reset ?? null,
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
