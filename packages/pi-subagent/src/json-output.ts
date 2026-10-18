import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";

const MAX_RECORD = 1024 * 1024;
const MAX_FINAL = 48 * 1024;
const MAX_DIAGNOSTIC = 4 * 1024;
const STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

export interface JsonOutput {
  readonly protocolError: string | undefined;
  feed: (chunk: Buffer) => void;
  end: () => void;
  assess: () => ParsedOutput;
}

export interface ParsedOutput {
  output: string;
  truncated: boolean;
  usage: Usage;
  error?: string;
}

interface State {
  header: boolean;
  settled: boolean;
  aborted: boolean;
  stop?: string;
  output: string;
  truncated: boolean;
  error?: string;
  protocolError?: string;
  usage: Usage;
  finalized: Set<string>;
  assistantEpoch: number;
}

export function createJsonOutput(): JsonOutput {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let ended = false;
  const state: State = {
    header: false,
    settled: false,
    aborted: false,
    output: "",
    truncated: false,
    usage: emptyUsage(),
    finalized: new Set(),
    assistantEpoch: 0,
  };
  const consume = (text: string) => {
    if (state.protocolError !== undefined) return;
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      parseLine(line, state);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending) > MAX_RECORD) {
      state.protocolError = "Pi protocol record exceeds 1 MiB.";
      pending = "";
    }
  };
  return {
    get protocolError() {
      return state.protocolError;
    },
    feed(chunk) {
      if (!ended) consume(decoder.write(chunk));
    },
    end() {
      if (ended) return;
      consume(decoder.end());
      if (pending.trim() !== "") parseLine(pending, state);
      pending = "";
      ended = true;
    },
    assess() {
      const error =
        state.protocolError ??
        (!state.header
          ? "Missing Pi session header."
          : !state.settled
            ? "Pi exited before agent_settled."
            : state.aborted
              ? "Pi settled after abort."
              : (state.error ??
                (state.stop !== "stop"
                  ? `Pi final stop reason: ${state.stop ?? "missing"}.`
                  : state.output.trim() === ""
                    ? "Pi settled without a final answer."
                    : undefined)));
      return { output: state.output, truncated: state.truncated, usage: state.usage, error };
    },
  };
}

function parseLine(line: string, state: State): void {
  if (line.trim() === "" || state.protocolError !== undefined) return;
  try {
    if (Buffer.byteLength(line) > MAX_RECORD) throw new Error("Pi protocol record exceeds 1 MiB.");
    const event: unknown = JSON.parse(line);
    if (!record(event) || typeof event.type !== "string")
      throw new Error("Expected a typed Pi event.");
    if (!state.header && event.type !== "session")
      throw new Error("Missing initial Pi session header.");
    switch (event.type) {
      case "session":
        if (
          state.header ||
          event.version !== 3 ||
          typeof event.id !== "string" ||
          !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(event.id) ||
          typeof event.cwd !== "string" ||
          event.cwd.trim() === "" ||
          typeof event.timestamp !== "string" ||
          !Number.isFinite(Date.parse(event.timestamp))
        ) {
          throw new Error("Invalid Pi 1.3.0 session header.");
        }
        state.header = true;
        return;
      case "agent_start":
      case "turn_start":
        resetAnswer(state);
        return;
      case "message_start":
        if (!record(event.message) || typeof event.message.role !== "string")
          throw new Error("Invalid message_start.");
        state.settled = false;
        if (event.message.role === "assistant") resetAnswer(state);
        return;
      case "message_end":
        captureMessage(event.message, state);
        return;
      case "agent_settled":
        if (typeof event.aborted !== "boolean")
          throw new Error("Invalid agent_settled aborted flag.");
        state.settled = true;
        state.aborted = event.aborted;
        return;
      case "auto_retry_start":
      case "compaction_start":
        state.settled = false;
        return;
      case "auto_retry_end":
        if (event.success === false && typeof event.finalError === "string")
          state.error = bounded(event.finalError, MAX_DIAGNOSTIC).text;
        return;
      default:
        return;
    }
  } catch (error) {
    state.protocolError = bounded(
      `Invalid Pi JSON stream: ${error instanceof Error ? error.message : String(error)}`,
      MAX_DIAGNOSTIC,
    ).text;
  }
}

function resetAnswer(state: State): void {
  ++state.assistantEpoch;
  state.output = "";
  state.truncated = false;
  state.stop = undefined;
  state.error = undefined;
  state.settled = false;
}

function captureMessage(message: unknown, state: State): void {
  if (!record(message) || typeof message.role !== "string") throw new Error("Invalid message_end.");
  state.settled = false;
  if (message.role === "toolResult") {
    if (typeof message.toolCallId !== "string") throw new Error("Invalid toolResult ID.");
    captureUsage(message.usage, `tool:${message.toolCallId}`, state);
    return;
  }
  if (message.role !== "assistant") return;
  if (
    !Array.isArray(message.content) ||
    typeof message.stopReason !== "string" ||
    !STOP_REASONS.has(message.stopReason) ||
    message.content.some(
      (block: unknown) =>
        !record(block) ||
        typeof block.type !== "string" ||
        (block.type === "text" && typeof block.text !== "string"),
    )
  )
    throw new Error("Invalid finalized assistant message.");
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp))
    throw new Error("Invalid assistant timestamp.");
  const text = message.content
    .flatMap((block: unknown) =>
      record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
  const answer = bounded(text, MAX_FINAL);
  state.output = answer.text;
  state.truncated = answer.truncated;
  state.stop = message.stopReason;
  state.error =
    typeof message.errorMessage === "string"
      ? bounded(message.errorMessage, MAX_DIAGNOSTIC).text
      : undefined;
  const id =
    typeof message.responseId === "string"
      ? message.responseId
      : `${message.provider}/${message.model}/${message.timestamp}`;
  captureUsage(message.usage, `assistant:${state.assistantEpoch}:${id}`, state);
}

function captureUsage(value: unknown, id: string, state: State): void {
  const key = createHash("sha256").update(id).digest("hex");
  if (value === undefined || state.finalized.has(key)) return;
  if (!record(value) || !record(value.cost)) throw new Error("Invalid finalized usage.");
  if (state.finalized.size >= 4096) throw new Error("Too many finalized usage records (4096).");
  const usage = emptyUsage();
  const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  const costs = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  for (const key of keys) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid usage token count.");
    usage[key] = count;
  }
  for (const key of ["cacheWrite1h", "reasoning"] as const) {
    const count = value[key];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid optional usage count.");
    usage[key] = count;
  }
  for (const key of costs) {
    const count = value.cost[key];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
      throw new Error("Invalid usage cost.");
    usage.cost[key] = count;
  }
  addUsage(state.usage, usage);
  state.finalized.add(key);
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, value: Usage): void {
  const updated = { ...total, cost: { ...total.cost } };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    updated[key] += value[key];
    if (!Number.isSafeInteger(updated[key])) throw new Error("Usage token overflow.");
  }
  for (const key of ["cacheWrite1h", "reasoning"] as const) {
    if (value[key] === undefined) continue;
    updated[key] = (updated[key] ?? 0) + value[key];
    if (!Number.isSafeInteger(updated[key])) throw new Error("Optional usage token overflow.");
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    updated.cost[key] += value.cost[key];
    if (!Number.isFinite(updated.cost[key])) throw new Error("Usage cost overflow.");
  }
  Object.assign(total, updated);
}

export function bounded(text: string, bytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return { text, truncated: false };
  const marker = "\n[truncated]";
  const limit = Math.max(0, bytes - Buffer.byteLength(marker));
  const decoder = new StringDecoder("utf8");
  return {
    text:
      decoder.write(buffer.subarray(0, limit)) + (bytes >= Buffer.byteLength(marker) ? marker : ""),
    truncated: true,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
