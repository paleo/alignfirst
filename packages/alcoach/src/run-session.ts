import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCallbackRequest, type CallbackRequest, fireCallback } from "./callback.js";
import { appendTranscript, applyCompletion } from "./log-file.js";
import type { CallbackConfig } from "./mode.js";

export interface RunConfig {
  prompt: string;
  logPath: string;
  cwd: string;
  isNew: boolean;
  isBackground: boolean;
  resume?: string;
  model?: string;
  skipPermissions: boolean;
  unset: string[];
  callback?: CallbackConfig;
}

export const RUN_CONFIG_ENV = "ALIGNFIRST_COACH_RUN_CONFIG";

export async function runSession(config: RunConfig): Promise<void> {
  const state = createStreamState();
  const outcome = await spawnClaude(config, state);
  const completion = buildCompletion(state, outcome);
  applyCompletion(config.logPath, completion);
  if (config.isBackground && config.callback) {
    await runCallback(config, config.callback);
  }
}

interface ClaudeOutcome {
  exitCode: number | null;
  stderr: string;
}

function spawnClaude(config: RunConfig, state: StreamState): Promise<ClaudeOutcome> {
  const child = spawn("claude", buildClaudeArgs(config), {
    cwd: config.cwd,
    env: buildClaudeEnv(process.env, config.unset),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    buffer = drainLines(buffer, (line) => appendEvent(config.logPath, line, state));
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (buffer.trim()) appendEvent(config.logPath, buffer, state);
      resolve({ exitCode: code, stderr });
    });
    child.on("error", (err) => resolve({ exitCode: 1, stderr: err.message }));
  });
}

export function buildClaudeArgs(config: RunConfig): string[] {
  const args = [config.prompt, "-p", "--output-format", "stream-json", "--verbose"];
  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "auto");
  }
  if (config.resume) args.push("--resume", config.resume);
  if (config.model) args.push("--model", config.model);
  return args;
}

// Strip every ALIGNFIRST_COACH_* var (including the callback token and the run-config blob) plus any name in
// the caller's ALIGNFIRST_COACH_UNSET list, so wrapper env never leaks into the claude child.
export function buildClaudeEnv(baseEnv: NodeJS.ProcessEnv, unset: string[]): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const name of unset) {
    const trimmed = name.trim();
    if (trimmed) delete env[trimmed];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("ALIGNFIRST_COACH_")) delete env[key];
  }
  return env;
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
  return rest;
}

function appendEvent(logPath: string, line: string, state: StreamState): void {
  const rendered = renderEvent(parseEventLine(line), state);
  if (rendered !== undefined) appendTranscript(logPath, `${rendered}\n`);
}

// --- NDJSON stream parsing ---

export interface StreamState {
  sessionId?: string;
  result?: string;
  isError: boolean;
}

export function createStreamState(): StreamState {
  return { isError: false };
}

export function parseEventLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparsed", raw: line };
  }
}

// Mutates `state` (session id, final result, error flag) and returns a human-readable line to
// append, or `undefined` when the event contributes nothing to the transcript body.
export function renderEvent(event: unknown, state: StreamState): string | undefined {
  if (!isRecord(event)) return;
  captureSessionId(event, state);
  switch (event.type) {
    case "system":
      return event.subtype === "init" ? `[init] session ${asString(event.session_id)}` : undefined;
    case "assistant":
      return renderMessageContent(event);
    case "user":
      return renderMessageContent(event);
    case "result":
      captureResult(event, state);
      return undefined;
    case "unparsed":
      return asString(event.raw);
    default:
      return undefined;
  }
}

function captureSessionId(event: Record<string, unknown>, state: StreamState): void {
  const id = asString(event.session_id);
  if (id) state.sessionId = id;
}

function captureResult(event: Record<string, unknown>, state: StreamState): void {
  state.isError = event.is_error === true;
  const result = asString(event.result);
  if (result !== undefined) state.result = result;
}

function renderMessageContent(event: Record<string, unknown>): string | undefined {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  const parts: string[] = [];
  for (const block of message.content) {
    const rendered = renderBlock(block);
    if (rendered) parts.push(rendered);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function renderBlock(block: unknown): string | undefined {
  if (!isRecord(block)) return;
  switch (block.type) {
    case "text":
      return asString(block.text);
    case "tool_use":
      return `[tool: ${asString(block.name) ?? "?"}] ${compactJson(block.input)}`;
    case "tool_result":
      return `[tool result] ${truncate(renderToolResult(block.content), 500)}`;
    default:
      return undefined;
  }
}

function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (isRecord(block) ? (asString(block.text) ?? "") : "")).join("");
  }
  return compactJson(content);
}

// --- Completion ---

function buildCompletion(state: StreamState, outcome: ClaudeOutcome) {
  const failed = state.isError || outcome.exitCode !== 0 || state.result === undefined;
  return {
    status: failed ? ("failed" as const) : ("succeeded" as const),
    endedAt: new Date().toISOString(),
    exitReason: failed ? "error" : "completed",
    sessionId: state.sessionId ?? null,
    result: state.result ?? failureMessage(outcome),
  };
}

function failureMessage(outcome: ClaudeOutcome): string {
  const stderr = outcome.stderr.trim();
  return stderr || `claude exited with code ${outcome.exitCode ?? "unknown"}`;
}

async function runCallback(config: RunConfig, callback: CallbackConfig): Promise<void> {
  const request: CallbackRequest = buildCallbackRequest(callback, config.logPath, config.cwd);
  // Log the attempt before firing: if the detached runner is reaped mid-callback, the absence of a
  // following "delivered"/"failed" line is itself the diagnostic. Absence of this whole block means
  // the runner never reached the callback at all.
  appendTranscript(
    config.logPath,
    `\n---- Callback ----\n\nPOST ${request.url} sessionKey=${callback.sessionKey}\n`,
  );
  try {
    await fireCallback(request);
    appendTranscript(config.logPath, "Callback delivered.\n");
  } catch (err) {
    appendTranscript(
      config.logPath,
      `Callback FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// --- Shared helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? "", 500);
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// --- Entry point (spawned as a detached child by the parent CLI) ---

function readConfigFromEnv(env: NodeJS.ProcessEnv): RunConfig {
  const raw = env[RUN_CONFIG_ENV];
  if (!raw) throw new Error(`Missing ${RUN_CONFIG_ENV} in the runner environment.`);
  return JSON.parse(raw) as RunConfig;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export function runSessionEntryPath(): string {
  return fileURLToPath(new URL("./run-session.js", import.meta.url));
}

if (isMainModule()) {
  void runSession(readConfigFromEnv(process.env)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
