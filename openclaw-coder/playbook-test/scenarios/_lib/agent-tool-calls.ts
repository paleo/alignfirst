import type { AgentToolCall } from "@paleo/openclaw-test";

export function inputOf(call: AgentToolCall): Record<string, unknown> {
  return call.input && typeof call.input === "object"
    ? (call.input as Record<string, unknown>)
    : {};
}

const READ_VIA_EXEC = /\b(cat|head|tail|less|bat)\b/;

/**
 * True when the call reads `fileName` — either the `read` tool with a matching
 * `path`, or an `exec` that cats/heads/tails it. `fileName` is matched as a
 * substring, so pass a discriminating suffix like `nimbus/DEVELOPMENT.md`.
 */
export function readsFile(call: AgentToolCall, fileName: string): boolean {
  const input = inputOf(call);
  if (call.toolName === "read" && typeof input.path === "string") {
    return input.path.includes(fileName);
  }
  if (call.toolName === "exec" && typeof input.command === "string") {
    return READ_VIA_EXEC.test(input.command) && input.command.includes(fileName);
  }
  return false;
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
// separator/subshell open (`(alcode … ; openclaw system event …)` is the guide's chained-wake
// launch shape) — but not a substring of another token.
const ALCODE_INVOCATION_RE = /(^|[\s/;(&|])alcode(\s|$)/;
// A direct `claude` invocation (the agent must NOT call the coding CLI itself —
// only alcode may, as its subprocess, which is a cliMock, not an agent tool call).
const CLAUDE_INVOCATION_RE = /(^|[\s/;(&|])claude(\s|$)/;

/** True when the call is an `exec` that invokes the real `alcode` CLI. */
export function invokesAlcode(call: AgentToolCall): boolean {
  const input = inputOf(call);
  return (
    call.toolName === "exec" &&
    typeof input.command === "string" &&
    ALCODE_INVOCATION_RE.test(input.command)
  );
}

/** True when the call is an `exec` that invokes `claude` directly (not via alcode). */
export function invokesClaudeDirectly(call: AgentToolCall): boolean {
  const input = inputOf(call);
  if (call.toolName !== "exec" || typeof input.command !== "string") return false;
  return CLAUDE_INVOCATION_RE.test(input.command) && !ALCODE_INVOCATION_RE.test(input.command);
}

/**
 * Stateful predicate for `waitForAgentToolCall` when the same call shape recurs in one scenario:
 * the wait matches against ALL aggregated calls, so a plain predicate would resolve again on the
 * first occurrence. Each distinct matching call (by `toolUseId`, met in the aggregated `ts` order)
 * gets a 1-based index on first sight; the predicate fires only on the `n`-th — the newest of the
 * first `n` matches. Single-use: the index map lives in the closure.
 */
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
