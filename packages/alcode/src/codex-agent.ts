import type { AgentAdapter, AgentProtocolState, RunConfig } from "./run-agent.js";

export function createCodexAdapter(): AgentAdapter {
  return {
    executable: "codex",
    buildArgs: buildCodexArgs,
    createState: createCodexState,
    interpretLine: interpretCodexLine,
    assess: assessCodexState,
    isAuthenticationError: isCodexAuthenticationMessage,
    authenticationMessage: codexAuthenticationMessage,
    failureMessage: missingCodexOutcome,
  };
}

export function buildCodexArgs(config: RunConfig): string[] {
  const args = ["exec", "--json"];
  if (config.skipPermissions) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write");
  }
  if (config.executableModel !== undefined) args.push("--model", config.executableModel);
  if (config.resume !== undefined) args.push("resume", config.resume);
  args.push(config.prompt);
  return args;
}

export function createCodexState(): AgentProtocolState {
  return {
    protocolComplete: false,
    protocolFailed: false,
    authEvidence: false,
  };
}

export function interpretCodexLine(line: string, state: AgentProtocolState): string | undefined {
  const event = parseCodexLine(line);
  if (!isRecord(event)) return;
  switch (event.type) {
    case "thread.started":
      return captureThread(event, state);
    case "item.completed":
      return captureCompletedItem(event, state);
    case "turn.completed":
      state.protocolComplete = true;
      return;
    case "turn.failed":
    case "error":
      return captureFailure(event, state);
    case "unparsed":
      return `[unparsed] ${asString(event.raw) ?? ""}`;
    default:
      return;
  }
}

export function assessCodexState(state: AgentProtocolState) {
  const succeeded = state.protocolComplete && !state.protocolFailed && state.result !== undefined;
  return {
    succeeded,
    sessionId: state.sessionId,
    result: state.result,
    error: succeeded ? undefined : state.failure,
    authEvidence: state.authEvidence,
  };
}

function parseCodexLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparsed", raw: line };
  }
}

function captureThread(event: Record<string, unknown>, state: AgentProtocolState): string {
  const id = asString(event.thread_id);
  if (id !== undefined && id !== "") state.sessionId = id;
  return `[init] session ${id ?? "?"}`;
}

function captureCompletedItem(
  event: Record<string, unknown>,
  state: AgentProtocolState,
): string | undefined {
  const item = event.item;
  if (!isRecord(item)) return;
  if (item.type === "agent_message") {
    const text = asString(item.text);
    if (text !== undefined && text !== "") state.result = text;
    return text;
  }
  if (item.type !== "error") return;
  const message = extractMessage(item);
  if (message === undefined) return;
  recordFailure(message, state);
  return `[error] ${message}`;
}

function captureFailure(
  event: Record<string, unknown>,
  state: AgentProtocolState,
): string | undefined {
  const message = extractMessage(event);
  state.protocolFailed = true;
  if (message === undefined) return;
  recordFailure(message, state);
  return `[error] ${message}`;
}

function recordFailure(message: string, state: AgentProtocolState): void {
  state.protocolFailed = true;
  state.failure = message;
  if (isCodexAuthenticationMessage(message)) state.authEvidence = true;
}

function extractMessage(value: Record<string, unknown>): string | undefined {
  const direct = asString(value.message);
  if (direct !== undefined) return direct;
  const error = value.error;
  if (typeof error === "string") return error;
  if (!isRecord(error)) return;
  return asString(error.message);
}

function isCodexAuthenticationMessage(message: string): boolean {
  const normalized = message.trim();
  return (
    /^(?:error:\s*)?(?:you are |user is )?not logged in\b/i.test(normalized) ||
    /^(?:error:\s*)?.*\brun [`']?codex login[`']?\b/i.test(normalized)
  );
}

function missingCodexOutcome(state: AgentProtocolState): string {
  if (!state.protocolComplete) return "Codex stream ended before turn.completed.";
  return "Codex turn completed without a final agent message.";
}

function codexAuthenticationMessage(detail?: string): string {
  const base =
    "Coding agent not authenticated: an administrator must run `codex login` on the host before " +
    "alcode can run again.";
  const reason = detail?.trim();
  return reason === undefined || reason === "" ? base : `${base}\n\n${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
