import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { CodingAgent } from "./coding-agent.js";
import { buildAgentEnv } from "./run-agent.js";

const USAGE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export interface UsageContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type UsageReader = (agent: CodingAgent, context: UsageContext) => Promise<string>;

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitBucket {
  id: string | null;
  name: string | null;
  windows: RateLimitWindow[];
}

export async function readUsage(agent: CodingAgent, context: UsageContext): Promise<string> {
  const env = buildAgentEnv(context.env, (context.env.ALIGNFIRST_CODE_UNSET ?? "").split(","));
  return agent === "claude"
    ? readClaudeUsage({ ...context, env })
    : readCodexUsage({ ...context, env });
}

async function readClaudeUsage(context: UsageContext): Promise<string> {
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", "/usage", "--tools", "", "--output-format", "json", "--no-session-persistence"],
    {
      cwd: context.cwd,
      env: context.env,
      encoding: "utf8",
      timeout: USAGE_TIMEOUT_MS,
    },
  );
  return `Claude Code usage\n\n${parseClaudeUsage(stdout)}`;
}

export function parseClaudeUsage(stdout: string): string {
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
  const trimmed = result.trim();
  if (trimmed === "") throw new Error("Claude Code returned an empty usage report.");
  return trimmed;
}

async function readCodexUsage(context: UsageContext): Promise<string> {
  const response = await requestCodexUsage(context);
  return formatCodexUsage(response);
}

function requestCodexUsage(context: UsageContext): Promise<unknown> {
  const child = spawn("codex", ["app-server"], {
    cwd: context.cwd,
    env: context.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const detachGuard = guardChild(child);
  let stdout = "";
  let stderr = "";

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
      USAGE_TIMEOUT_MS,
    );

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      stdout = drainJsonLines(stdout, (message) => {
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
      });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin?.on("error", (error) => {
      finish(new Error(`Codex could not read usage limits: ${error.message}`));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const detail = stderr.trim();
      finish(
        new Error(
          detail !== ""
            ? `Codex could not read usage limits: ${detail}`
            : `Codex app-server exited with code ${code ?? "unknown"}.`,
        ),
      );
    });

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
  });
}

function guardChild(child: ChildProcess): () => void {
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("exit", kill);
  return () => process.off("exit", kill);
}

function sendCodexMessage(child: ChildProcess, message: unknown): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
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

export function formatCodexUsage(
  response: unknown,
  formatTime: (timestampSeconds: number) => string = formatLocalTime,
): string {
  const buckets = parseCodexBuckets(response);
  const rendered = buckets.map((bucket) => formatBucket(bucket, formatTime));
  return `Codex usage\n\n${rendered.join("\n\n")}`;
}

function parseCodexBuckets(response: unknown): RateLimitBucket[] {
  if (!isRecord(response)) throw new Error("Codex returned an unexpected usage response.");
  const multiBucket = response.rateLimitsByLimitId;
  const values = isRecord(multiBucket) ? Object.values(multiBucket) : [response.rateLimits];
  const buckets = values.flatMap(parseBucket);
  if (buckets.length === 0) {
    throw new Error("Codex returned no usage windows for the current account.");
  }
  return buckets;
}

function parseBucket(value: unknown): RateLimitBucket[] {
  if (!isRecord(value)) return [];
  const windows = [parseWindow(value.primary), parseWindow(value.secondary)].filter(
    (window): window is RateLimitWindow => window !== undefined,
  );
  if (windows.length === 0) return [];
  return [
    {
      id: typeof value.limitId === "string" ? value.limitId : null,
      name: typeof value.limitName === "string" ? value.limitName : null,
      windows,
    },
  ];
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
  const name = bucket.name ?? (bucket.id === "codex" ? "Codex" : bucket.id) ?? "Codex";
  const windows = bucket.windows.map((window, index) => {
    const duration = formatDuration(window.windowDurationMins, index);
    const reset = window.resetsAt === null ? "" : ` · resets ${formatTime(window.resetsAt)}`;
    return `  ${duration}: ${window.usedPercent}% used${reset}`;
  });
  return `${name}\n${windows.join("\n")}`;
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
