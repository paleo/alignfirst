import type { AgentToolCall } from "@paleo/openclaw-test";

function inputOf(call: AgentToolCall): Record<string, unknown> {
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
  const input = inputOf(call);
  return (
    call.toolName === "exec" && typeof input.command === "string" && pattern.test(input.command)
  );
}
