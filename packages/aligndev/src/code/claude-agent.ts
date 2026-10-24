import { captureNativeSession, isCompacted } from "./run-agent.js";
import type { AgentAdapter, AgentProtocolState, RunConfig } from "./run-agent.js";

// After the agent's turn, `claude -p` waits for its background work, but stops it after 10 minutes
// of idle waiting by default. `0` waits until the work ends.
const CLAUDE_ENV = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };

export function createClaudeAdapter(): AgentAdapter {
  return {
    executable: "claude",
    env: CLAUDE_ENV,
    buildArgs: buildClaudeArgs,
    createState: createClaudeState,
    interpretLine: interpretClaudeLine,
    assess: assessClaudeState,
    isAuthenticationError: () => false,
    authenticationMessage: claudeAuthenticationMessage,
  };
}

export function buildClaudeArgs(config: RunConfig): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "auto");
  }
  // `--add-dir` is variadic: only options may follow it. The prompt goes through stdin.
  for (const dir of config.additionalDirectories) args.push("--add-dir", dir);
  if (config.resume !== undefined) args.push("--resume", config.resume);
  if (config.executableModel !== undefined) args.push("--model", config.executableModel);
  return args;
}

export function createClaudeState(config?: RunConfig): AgentProtocolState {
  return {
    expectedSessionId: config?.resume,
    earlierResults: [],
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
      captureContextTokens(event, state);
      return renderMessageContent(event);
    case "user":
      return renderMessageContent(event);
    case "result":
      state.protocolComplete = true;
      state.protocolFailed = event.is_error === true;
      captureResult(asString(event.result), state);
      return;
    case "unparsed":
      return asString(event.raw);
    default:
      return;
  }
}

export function assessClaudeState(state: AgentProtocolState) {
  return {
    succeeded:
      state.sessionId !== undefined &&
      state.identityFailure === undefined &&
      state.protocolComplete &&
      !state.protocolFailed &&
      state.result !== undefined,
    sessionId: state.sessionId,
    result: state.result,
    error:
      state.identityFailure ??
      state.failure ??
      (state.sessionId === undefined &&
      (state.protocolComplete || state.expectedSessionId !== undefined)
        ? "Claude reported no native session identity in the selected native configuration."
        : undefined),
    authEvidence: state.authEvidence,
    contextTokens: state.contextTokens,
    contextCompacted: isCompacted(state),
  };
}

// Background turns each close with a result. Keep superseded responses; empty turns erase none.
function captureResult(result: string | undefined, state: AgentProtocolState): void {
  if (state.protocolFailed) state.failure = result;
  if (result === "" || result === undefined) return;
  if (state.result !== undefined) state.earlierResults.push(state.result);
  state.result = result;
  state.resultComplete = !state.protocolFailed;
}

// What the newest assistant response holds in the context window. Claude reports cache reads and
// writes beside `input_tokens`, so the occupancy is their sum plus the response itself. A subagent
// message carries `parent_tool_use_id` and measures its own context, not the main conversation's.
function captureContextTokens(event: Record<string, unknown>, state: AgentProtocolState): void {
  if (event.parent_tool_use_id != null) return;
  const message = event.message;
  if (!isRecord(message) || !isRecord(message.usage)) return;
  const usage = message.usage;
  const total =
    asCount(usage.input_tokens) +
    asCount(usage.cache_creation_input_tokens) +
    asCount(usage.cache_read_input_tokens) +
    asCount(usage.output_tokens);
  if (total === 0) return;
  state.contextTokens = total;
  state.peakContextTokens = Math.max(state.peakContextTokens ?? 0, total);
}

function parseEventLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparsed", raw: line };
  }
}

function captureSessionId(event: Record<string, unknown>, state: AgentProtocolState): void {
  if (event.session_id !== undefined || (event.type === "system" && event.subtype === "init")) {
    captureNativeSession(state, event.session_id, "Claude");
  }
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
    "expired, or rejected. An administrator must re-login with the same effective environment and cwd as the child " +
    "(apply profile unset/env/configDir, including HOME, PATH and credential routing; run `claude`, then " +
    "`/login`) before another coding run.";
  const reason = detail?.trim();
  return reason === undefined || reason === "" ? base : `${base}\n\n${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
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
