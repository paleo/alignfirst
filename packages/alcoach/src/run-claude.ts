import { type ChildProcess, spawn } from "node:child_process";

import { appendTranscript, applyCompletion } from "./log-file.js";

export interface RunConfig {
  prompt: string;
  logPath: string;
  cwd: string;
  isNew: boolean;
  resume?: string;
  model?: string;
  skipPermissions: boolean;
  unset: string[];
}

export interface RunOutput {
  write(text: string): void;
}

export interface RunResult {
  status: "succeeded" | "failed";
  sessionId: string | null;
  result: string;
}

// Runs `claude` as a direct foreground child of this process: parses its NDJSON stream, mirrors a
// human-readable transcript to both the log file and `out` as it arrives, and on exit rewrites the
// log's terminal frontmatter and returns the outcome. OpenClaw backgrounds *alcoach* via its own
// `exec` tool and wakes on alcoach's exit — alcoach itself never detaches.
export async function runClaude(config: RunConfig, out: RunOutput): Promise<RunResult> {
  const state = createStreamState();
  const outcome = await spawnClaude(config, state, out);
  const failed = state.isError || outcome.exitCode !== 0 || state.result === undefined;
  const result = state.result ?? failureMessage(outcome);
  applyCompletion(config.logPath, {
    status: failed ? "failed" : "succeeded",
    endedAt: new Date().toISOString(),
    exitReason: failed ? "error" : "completed",
    sessionId: state.sessionId ?? null,
    result,
  });
  return { status: failed ? "failed" : "succeeded", sessionId: state.sessionId ?? null, result };
}

interface ClaudeOutcome {
  exitCode: number | null;
  stderr: string;
}

function spawnClaude(
  config: RunConfig,
  state: StreamState,
  out: RunOutput,
): Promise<ClaudeOutcome> {
  const child = spawn("claude", buildClaudeArgs(config), {
    cwd: config.cwd,
    env: buildClaudeEnv(process.env, config.unset),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const detachChildGuards = guardChildLifecycle(child);
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    buffer = drainLines(buffer, (line) => emitEvent(config.logPath, line, state, out));
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (buffer.trim()) emitEvent(config.logPath, buffer, state, out);
      detachChildGuards();
      resolve({ exitCode: code, stderr });
    });
    child.on("error", (err) => {
      detachChildGuards();
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}

// A direct `kill <alcoach>` (not a process-group kill) would otherwise orphan the foreground
// `claude`. Forward termination signals and process exit to the child, then SIGKILL it, so alcoach
// never leaves a dangling `claude`. Returns a teardown that removes the guards once the child is
// gone (so alcoach can exit normally afterward).
function guardChildLifecycle(child: ChildProcess): () => void {
  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child is already gone; nothing to clean up.
      }
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    killChild();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", killChild);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", killChild);
  };
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

// Strip every ALIGNFIRST_COACH_* var plus any name in the caller's ALIGNFIRST_COACH_UNSET list, so
// wrapper env never leaks into the claude child.
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

function emitEvent(logPath: string, line: string, state: StreamState, out: RunOutput): void {
  const rendered = renderEvent(parseEventLine(line), state);
  if (rendered === undefined) return;
  appendTranscript(logPath, `${rendered}\n`);
  out.write(`${rendered}\n`);
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

function failureMessage(outcome: ClaudeOutcome): string {
  const stderr = outcome.stderr.trim();
  return stderr || `claude exited with code ${outcome.exitCode ?? "unknown"}`;
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
