import type { AgentAdapter, AgentProtocolState, RunConfig } from "./run-agent.js";

export function createClaudeAdapter(): AgentAdapter {
  return {
    executable: "claude",
    buildArgs: buildClaudeArgs,
    createState: createClaudeState,
    interpretLine: interpretClaudeLine,
    assess: assessClaudeState,
    isAuthenticationError: () => false,
    authenticationMessage: claudeAuthenticationMessage,
  };
}

export function buildClaudeArgs(config: RunConfig): string[] {
  const args = [config.prompt, "-p", "--output-format", "stream-json", "--verbose"];
  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "auto");
  }
  if (config.resume !== undefined) args.push("--resume", config.resume);
  if (config.executableModel !== undefined) args.push("--model", config.executableModel);
  return args;
}

export function createClaudeState(): AgentProtocolState {
  return {
    protocolComplete: false,
    protocolFailed: false,
    authEvidence: false,
  };
}

export function interpretClaudeLine(line: string, state: AgentProtocolState): string | undefined {
  const event = parseEventLine(line);
  if (!isRecord(event)) return;
  captureSessionId(event, state);
  if (event.error === "authentication_failed") state.authEvidence = true;
  switch (event.type) {
    case "system":
      return event.subtype === "init" ? `[init] session ${asString(event.session_id)}` : undefined;
    case "assistant":
    case "user":
      return renderMessageContent(event);
    case "result":
      state.protocolComplete = true;
      state.protocolFailed = event.is_error === true;
      state.result = asString(event.result);
      if (state.protocolFailed) state.failure = state.result;
      return;
    case "unparsed":
      return asString(event.raw);
    default:
      return;
  }
}

export function assessClaudeState(state: AgentProtocolState) {
  return {
    succeeded: state.protocolComplete && !state.protocolFailed && state.result !== undefined,
    sessionId: state.sessionId,
    result: state.result,
    error: state.failure,
    authEvidence: state.authEvidence,
  };
}

function parseEventLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparsed", raw: line };
  }
}

function captureSessionId(event: Record<string, unknown>, state: AgentProtocolState): void {
  const id = asString(event.session_id);
  if (id !== undefined && id !== "") state.sessionId = id;
}

function renderMessageContent(event: Record<string, unknown>): string | undefined {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  const parts: string[] = [];
  for (const block of message.content) {
    const rendered = renderBlock(block);
    if (rendered !== undefined && rendered !== "") parts.push(rendered);
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
      return;
  }
}

function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (isRecord(block) ? (asString(block.text) ?? "") : "")).join("");
  }
  return compactJson(content);
}

function claudeAuthenticationMessage(detail?: string): string {
  const base =
    "Coding agent not authenticated (authentication_failed): the host session is missing, " +
    "expired, or rejected. An administrator must re-login on the host (run `claude`, then " +
    "`/login`) before alcode can run again.";
  const reason = detail?.trim();
  return reason === undefined || reason === "" ? base : `${base}\n\n${reason}`;
}

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
