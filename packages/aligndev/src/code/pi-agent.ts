import type { AgentAdapter, AgentAssessment, AgentProtocolState, RunConfig } from "./run-agent.js";

const MISSING_USAGE = "Pi's latest assistant message did not report valid context usage.";
const STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

interface PiState extends AgentProtocolState {
  expectedSessionId?: string;
  headerSeen: boolean;
  stopReason?: string;
  settledAborted: boolean;
}

export function createPiAdapter(): AgentAdapter {
  return {
    executable: "pi",
    buildArgs: buildPiArgs,
    createState: createPiState,
    interpretLine: interpretPiLine,
    assess: assessPiState,
    isAuthenticationError: isPiAuthenticationError,
    authenticationMessage: piAuthenticationMessage,
    failureMessage: piFailure,
  };
}

function buildPiArgs(config: RunConfig): string[] {
  const args = ["--mode", "json"];
  if (config.executableModel !== undefined) args.push("--model", config.executableModel);
  if (config.resume !== undefined) args.push("--session", config.resume);
  return args;
}

function createPiState(config: RunConfig): PiState {
  return {
    expectedSessionId: config.resume,
    headerSeen: false,
    settledAborted: false,
    protocolComplete: false,
    protocolFailed: false,
    authEvidence: false,
    contextCompacted: false,
    contextTokensError: MISSING_USAGE,
  };
}

function interpretPiLine(line: string, state: PiState): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return invalidProtocol(state, "invalid JSON record");
  }
  if (!isRecord(event) || typeof event.type !== "string") {
    return invalidProtocol(state, "expected an event object with a type");
  }
  if (!state.headerSeen && event.type !== "session") {
    invalidProtocol(state, "missing initial session header");
  }
  switch (event.type) {
    case "session":
      return captureHeader(event, state);
    case "agent_start":
    case "turn_start":
      state.stopReason = undefined;
      state.result = undefined;
      state.protocolComplete = false;
      return;
    case "auto_retry_start":
    case "compaction_start":
      state.protocolComplete = false;
      return;
    case "message_start":
      state.protocolComplete = false;
      if (isRecord(event.message) && event.message.role === "assistant") {
        state.stopReason = undefined;
        state.result = undefined;
        captureUsage(undefined, state);
      }
      return;
    case "message_end":
      return captureMessage(event, state);
    case "agent_settled":
      if (typeof event.aborted !== "boolean") {
        return invalidProtocol(state, "agent_settled requires an aborted boolean");
      }
      state.protocolComplete = true;
      state.settledAborted = event.aborted;
      return;
    case "tool_execution_start":
    case "tool_execution_end":
      return renderTool(event);
    case "compaction_end":
      if (event.aborted === false && isRecord(event.result)) state.contextCompacted = true;
      return;
    case "auto_retry_end":
      if (event.success === false && typeof event.finalError === "string") {
        state.failure = event.finalError;
        state.authEvidence = isPiAuthenticationError(event.finalError);
      }
      return;
    default:
      return;
  }
}

function invalidProtocol(state: PiState, detail: string): string {
  state.protocolFailed = true;
  state.failure = `Invalid pi JSON stream: ${detail}.`;
  return `[error] ${state.failure}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureHeader(event: Record<string, unknown>, state: PiState): string {
  if (
    state.headerSeen ||
    event.version !== 3 ||
    typeof event.id !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(event.id) ||
    typeof event.cwd !== "string" ||
    event.cwd.trim() === "" ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    return invalidProtocol(state, "invalid or unsupported session header (requires pi 1.3.0)");
  }
  state.headerSeen = true;
  if (state.expectedSessionId !== undefined && event.id !== state.expectedSessionId) {
    return invalidProtocol(
      state,
      `resumed session ID ${event.id} differs from ${state.expectedSessionId}`,
    );
  }
  state.sessionId = event.id;
  return `[init] session ${event.id}`;
}

function captureMessage(event: Record<string, unknown>, state: PiState): string | undefined {
  state.protocolComplete = false;
  const message = event.message;
  if (!isRecord(message) || typeof message.role !== "string") {
    return invalidProtocol(state, "message_end requires a message with a role");
  }
  if (message.role !== "assistant") return;
  captureUsage(message.usage, state);
  if (
    !Array.isArray(message.content) ||
    typeof message.stopReason !== "string" ||
    !STOP_REASONS.has(message.stopReason) ||
    message.content.some(
      (block) =>
        !isRecord(block) ||
        typeof block.type !== "string" ||
        (block.type === "text" && typeof block.text !== "string"),
    )
  ) {
    return invalidProtocol(state, "invalid assistant message_end content or stop reason");
  }
  state.stopReason = message.stopReason;
  const text = message.content
    .flatMap((block: unknown) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  state.result = text.trim() === "" ? undefined : text;
  // A malformed protocol remains fatal even if a later model response succeeds.
  if (!state.protocolFailed) {
    state.failure = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  }
  state.authEvidence =
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    typeof message.errorMessage === "string" &&
    isPiAuthenticationError(message.errorMessage);
  return state.result ?? (state.failure === undefined ? undefined : `[error] ${state.failure}`);
}

function captureUsage(usage: unknown, state: PiState): void {
  state.contextTokens = undefined;
  state.contextTokensError = MISSING_USAGE;
  if (!isRecord(usage)) return;
  let total = 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const count = usage[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return;
    total += count;
  }
  if (!Number.isSafeInteger(total)) return;
  state.contextTokens = total;
  state.contextTokensError = undefined;
}

function renderTool(event: Record<string, unknown>): string | undefined {
  if (typeof event.toolName !== "string") return;
  const outcome =
    event.type === "tool_execution_start" ? "start" : event.isError === true ? "error" : "done";
  return `[tool: ${event.toolName}] ${outcome}`;
}

function assessPiState(state: PiState): AgentAssessment {
  const succeeded =
    state.sessionId !== undefined &&
    state.protocolComplete &&
    !state.protocolFailed &&
    !state.settledAborted &&
    state.stopReason === "stop" &&
    state.result !== undefined &&
    state.failure === undefined;
  return {
    succeeded,
    sessionId: state.sessionId,
    result: state.result,
    error: succeeded || (!state.headerSeen && !state.protocolFailed) ? undefined : piFailure(state),
    authEvidence: state.authEvidence,
    contextTokens: state.contextTokens,
    contextCompacted: state.contextCompacted,
    contextTokensError: state.contextTokensError,
  };
}

function piFailure(state: PiState): string {
  if (state.failure !== undefined) return state.failure;
  if (state.sessionId === undefined) return "Pi stream ended without valid session identity.";
  if (!state.protocolComplete) return "Pi stream ended before agent_settled.";
  if (state.settledAborted) return "Pi run settled after an abort.";
  if (state.stopReason !== "stop")
    return `Pi final assistant stop reason: ${state.stopReason ?? "missing"}.`;
  return "Pi run settled without a meaningful final assistant result.";
}

function isPiAuthenticationError(message: string): boolean {
  return message
    .split("\n")
    .some(
      (line) =>
        /^(?:Error:\s*)?No API key found for [^\r\n]+\.\s*$/.test(line.trim()) ||
        /^(?:Error:\s*)?Authentication failed for "[^"]+"[.:\s]/.test(line.trim()),
    );
}

function piAuthenticationMessage(detail?: string): string {
  const base =
    "Coding agent not authenticated: run `pi`, then `/login <provider>`, or configure " +
    "the provider's credentials before running `aligndev code` again.";
  return detail === undefined || detail.trim() === "" ? base : `${base}\n\n${detail}`;
}
