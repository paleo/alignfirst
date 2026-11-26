import { captureNativeSession, isCompacted } from "./run-agent.js";
import type { AgentAdapter, AgentAssessment, AgentProtocolState, RunConfig } from "./run-agent.js";

interface AgyState extends AgentProtocolState {
  // Text fragments of the main conversation's `agent_response` steps, by `step_index`.
  responseSteps: Map<number, string>;
}

export function createAgyAdapter(): AgentAdapter {
  return {
    executable: "agy",
    buildArgs: buildAgyArgs,
    formatInput: formatAgyInput,
    createState: createAgyState,
    interpretLine: interpretAgyLine,
    assess: assessAgyState,
    isAuthenticationError: isAgyAuthenticationError,
    failureMessage: missingAgyOutcome,
  };
}

// Headless runs use Antigravity's auto mode: no flag selects it.
function buildAgyArgs(config: RunConfig): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
  ];
  if (config.skipPermissions) args.push("--dangerously-skip-permissions");
  for (const dir of config.additionalDirectories) args.push("--add-dir", dir);
  if (config.resume !== undefined) args.push("--conversation", config.resume);
  if (config.executableModel !== undefined) args.push("--model", config.executableModel);
  if (config.effort !== undefined) args.push("--effort", config.effort);
  return args;
}

// Antigravity starts its shell in the workspace directory that sorts first by path, and names it
// as the command working directory. An added directory that sorts before the working directory,
// such as a companion or a linked worktree's git directory, takes its place: the note restores it.
function formatAgyInput(config: RunConfig): string {
  const content =
    config.additionalDirectories.length === 0
      ? config.prompt
      : `${workingDirectoryNote(config.cwd)}\n\n${config.prompt}`;
  return `${JSON.stringify({ event: "user", message: { content } })}\n`;
}

function workingDirectoryNote(cwd: string): string {
  return `Your working directory is \`${cwd}\`: run every shell command there, even where your context names another command working directory.`;
}

function createAgyState(config: RunConfig): AgyState {
  return {
    expectedSessionId: config.resume,
    earlierResults: [],
    protocolComplete: false,
    protocolFailed: false,
    authEvidence: false,
    responseSteps: new Map(),
  };
}

function interpretAgyLine(line: string, state: AgyState): string | undefined {
  const event = parseEventLine(line);
  if (event === undefined) return `[unparsed] ${line}`;
  switch (event.event) {
    case "init":
      captureNativeSession(state, event.conversation_id, "Antigravity");
      return `[init] session ${asString(event.conversation_id)}`;
    case "step_update":
      return isRecord(event.step_update) ? interpretStep(event.step_update, state) : undefined;
    case "result":
      if (isRecord(event.result)) captureResult(event.result, state);
      return;
    default:
      return;
  }
}

function parseEventLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return;
  }
}

function interpretStep(step: Record<string, unknown>, state: AgyState): string | undefined {
  switch (step.step_type) {
    case "agent_response":
      return interpretResponseStep(step, state);
    case "tool":
      return renderToolStep(step);
    default:
      return;
  }
}

// A step of another conversation belongs to a subagent.
function interpretResponseStep(step: Record<string, unknown>, state: AgyState): string | undefined {
  if (step.conversation_id !== state.sessionId) return;
  const index = step.step_index;
  if (typeof index !== "number") return;
  const delta = asString(step.text_delta);
  const text = (state.responseSteps.get(index) ?? "") + (delta ?? "");
  if (step.state !== "DONE") {
    state.responseSteps.set(index, text);
    return;
  }
  state.responseSteps.delete(index);
  captureContextTokens(step.usage, state);
  return text.trim() === "" ? undefined : text;
}

// The occupancy of the newest response. `result.usage` is cumulative over the conversation.
function captureContextTokens(usage: unknown, state: AgyState): void {
  if (!isRecord(usage)) return;
  const total =
    asCount(usage.input_tokens) + asCount(usage.cache_read_tokens) + asCount(usage.output_tokens);
  if (total === 0) return;
  state.contextTokens = total;
  state.peakContextTokens = Math.max(state.peakContextTokens ?? 0, total);
}

function renderToolStep(step: Record<string, unknown>): string | undefined {
  const info = isRecord(step.tool_info) ? step.tool_info : {};
  if (step.state === "ACTIVE") {
    return `[tool: ${asString(step.tool_name) ?? "?"}] ${compactJson(info.parameters)}`;
  }
  if (step.state !== "DONE") return;
  if (info.error !== undefined && info.error !== null) {
    return `[tool error] ${truncate(asString(info.error) ?? compactJson(info.error), 500)}`;
  }
  return `[tool result] ${truncate(asString(info.output) ?? compactJson(info.output), 500)}`;
}

// A blank response under SUCCESS sets no failure: the runner then reports stderr, which carries
// Antigravity's own notice of a denied tool permission.
function captureResult(result: Record<string, unknown>, state: AgyState): void {
  state.protocolComplete = true;
  const error = asString(result.error);
  if (error !== undefined && /^authentication/i.test(error)) state.authEvidence = true;
  if (result.status === "SUCCESS" && result.finished_reason == null) {
    const response = asString(result.response);
    if (response === undefined || response.trim() === "") return;
    state.result = response;
    state.resultComplete = true;
    return;
  }
  state.protocolFailed = true;
  state.failure = error !== undefined && error.trim() !== "" ? error : describeEarlyEnd(result);
}

function describeEarlyEnd(result: Record<string, unknown>): string {
  const status = `Antigravity ended with status ${compactJson(result.status)}`;
  return result.finished_reason == null
    ? `${status}.`
    : `${status} and finished reason ${compactJson(result.finished_reason)}.`;
}

function assessAgyState(state: AgyState): AgentAssessment {
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
        ? "Antigravity reported no native session identity in the selected native configuration."
        : undefined),
    authEvidence: state.authEvidence,
    contextTokens: state.contextTokens,
    contextCompacted: isCompacted(state),
  };
}

function isAgyAuthenticationError(message: string): boolean {
  return message
    .split("\n")
    .some((line) => line.trim().startsWith("Error: authentication required"));
}

function missingAgyOutcome(state: AgentProtocolState): string {
  if (!state.protocolComplete) return "Antigravity stream ended before its result.";
  return "Antigravity completed without a response; a tool permission was probably denied in headless mode.";
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
