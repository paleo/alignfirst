import type { AgentToolCall } from "@paleo/openclaw-test";
import { escapeRe } from "./common-constants.ts";

const PROJECT_LIST_JSON_RE = /(^|[\s/;(&|])alproject\s+list\b.*--json/;

export function inputOf(call: AgentToolCall): Record<string, unknown> {
  return call.input && typeof call.input === "object"
    ? (call.input as Record<string, unknown>)
    : {};
}

const READ_VIA_EXEC = /\b(cat|head|tail|less|bat)\b/;

/**
 * True when the call reads `fileName` — either the `read` tool with a matching
 * `path`, or an `exec` that cats/heads/tails it. `fileName` is matched as a
 * substring, so pass a discriminating suffix like `nimbus/DEVELOPERS.md`.
 */
export function readsFile(call: AgentToolCall, fileName: string): boolean {
  const input = inputOf(call);
  if (call.toolName === "read" && typeof input.path === "string") {
    return input.path.includes(fileName);
  }
  if (call.toolName === "exec" && typeof input.command === "string") {
    return READ_VIA_EXEC.test(input.command) && namesFile(input.command, fileName);
  }
  return false;
}

// The command names the file by its full path, or `cd`s into its directory and names it bare
// (`cd /proj && cat DEVELOPERS.md`).
function namesFile(command: string, fileName: string): boolean {
  if (command.includes(fileName)) return true;
  const slash = fileName.lastIndexOf("/");
  if (slash <= 0) return false;
  const dir = fileName.slice(0, slash);
  const base = fileName.slice(slash + 1);
  return new RegExp(`\\bcd\\s+${escapeRe(dir)}\\b`).test(command) && command.includes(base);
}

/** True when the call is an `exec` whose command matches `pattern`. */
export function execMatches(call: AgentToolCall, pattern: RegExp): boolean {
  const command = execCommandOf(call);
  return command !== undefined && pattern.test(command);
}

/** The exec `command` string, or undefined when the call is not an exec. */
export function execCommandOf(call: AgentToolCall): string | undefined {
  const input = inputOf(call);
  return call.toolName === "exec" && typeof input.command === "string" ? input.command : undefined;
}

// `alcode` at a word boundary — bare, absolute path (`/usr/local/bin/alcode …`), or after a shell
// separator/subshell open (`(alcode … ; openclaw system event …)` is the guide's chained
// completion-event launch shape) — but not a substring of another token.
const ALCODE_INVOCATION_RE = /(^|[\s/;(&|])alcode(\s|$)/;
// Only alcode may launch a coding agent. Its subprocess appears as a cliMock entry rather than an
// OpenClaw agent tool call.
const CODING_AGENT_INVOCATION_RE = /(^|[\s/;(&|])(claude|codex)(\s|$)/;

/** True when the call is an `exec` that invokes the real `alcode` CLI. */
export function invokesAlcode(call: AgentToolCall): boolean {
  const input = inputOf(call);
  return (
    call.toolName === "exec" &&
    typeof input.command === "string" &&
    ALCODE_INVOCATION_RE.test(input.command)
  );
}

export function listsProjects(call: AgentToolCall): boolean {
  const command = execCommandOf(call);
  return command !== undefined && PROJECT_LIST_JSON_RE.test(command);
}

/** Counts distinct tool calls across repeated polls of the aggregated transcript. */
export function nthMatchingCall(
  predicate: (call: AgentToolCall) => boolean,
  n: number,
): (call: AgentToolCall) => boolean {
  const indexByToolUseId = new Map<string, number>();
  return (call) => {
    if (!predicate(call)) return false;
    const known = indexByToolUseId.get(call.toolUseId);
    const index = known ?? indexByToolUseId.size + 1;
    if (known === undefined) indexByToolUseId.set(call.toolUseId, index);
    return index === n;
  };
}

/** True when the call is an `exec` that invokes Claude or Codex directly. */
export function invokesCodingAgentDirectly(call: AgentToolCall): boolean {
  const input = inputOf(call);
  if (call.toolName !== "exec" || typeof input.command !== "string") return false;
  return (
    CODING_AGENT_INVOCATION_RE.test(input.command) && !ALCODE_INVOCATION_RE.test(input.command)
  );
}
