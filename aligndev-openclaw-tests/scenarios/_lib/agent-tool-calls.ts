import type { AgentToolCall } from "@alignfirst/openclaw-test";
import { escapeRe } from "./common-constants.ts";

const PROJECT_LIST_JSON_RE = /(^|[\s/;(&|])aligndev\s+project\s+list\b.*--json/;

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
    const workdir = typeof input.workdir === "string" ? input.workdir : undefined;
    return READ_VIA_EXEC.test(input.command) && namesFile(input.command, workdir, fileName);
  }
  return false;
}

// The command names the file by its full path, or runs in its directory and names it bare: through
// `cd` (`cd /proj && cat DEVELOPERS.md`) or the exec `workdir` parameter.
function namesFile(command: string, workdir: string | undefined, fileName: string): boolean {
  if (command.includes(fileName)) return true;
  const slash = fileName.lastIndexOf("/");
  if (slash <= 0) return false;
  const dir = fileName.slice(0, slash);
  const base = fileName.slice(slash + 1);
  const inDir =
    workdir?.replace(/\/+$/, "") === dir ||
    new RegExp(`\\bcd\\s+${escapeRe(dir)}\\b`).test(command);
  return inDir && command.includes(base);
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

// A coding-agent launch. `aligndev code status` and `aligndev guide code` launch nothing.
const ALIGNDEV_CODE_LAUNCH_RE = /(^|[\s/;(&|])aligndev\s+code\s+(new|resume)(\s|$)/;

/** True when the call is an `exec` that launches the coding agent through the real `aligndev code` CLI. */
export function invokesAligndevCode(call: AgentToolCall): boolean {
  const command = execCommandOf(call);
  return command !== undefined && ALIGNDEV_CODE_LAUNCH_RE.test(command);
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

/** True when the call is an `exec` that invokes Claude, Codex or Pi directly. */
export function invokesCodingAgentDirectly(call: AgentToolCall): boolean {
  const command = execCommandOf(call);
  if (command === undefined) return false;
  for (const words of shellCommands(command)) {
    if (launchesNativeAgent(words)) return true;
  }
  return false;
}

// Only `aligndev code` may launch a coding agent. Its child is recorded as a cliMock entry.
function launchesNativeAgent(words: string[]): boolean {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_]\w*=/.test(word)) {
      ++index;
    } else if (/^(env|command|exec|npx|sudo)$/.test(word)) {
      ++index;
      while (index < words.length && /^-[\w-]+$/.test(words[index])) ++index;
    } else {
      return /^(?:.*\/)?(claude|codex|pi)$/.test(word);
    }
  }
  return false;
}

// Track words, quotes and executable substitutions, not the full shell grammar.
function* shellCommands(
  command: string,
  start = 0,
  terminator?: ")" | "`",
): Generator<string[], number> {
  let words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  let parentheses = 0;
  let index = start;
  for (; index < command.length; ++index) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "\\" && quote !== "'" && next !== undefined) {
      if (quote === undefined || /[$`"\\\n]/.test(next)) {
        if (next !== "\n") word = (word ?? "") + next;
        ++index;
        continue;
      }
    }
    if (quote === undefined && char === terminator && parentheses === 0) break;
    if (quote !== "'" && (char === "`" || (char === "$" && next === "("))) {
      const closing = char === "`" ? "`" : ")";
      index = yield* shellCommands(command, index + (char === "`" ? 1 : 2), closing);
      // Expansion output is unknown; do not join surrounding fragments into a literal agent name.
      word = `${word ?? ""}$()`;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word = (word ?? "") + char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
      continue;
    }
    if (char === "#" && word === undefined) {
      while (index < command.length && command[index] !== "\n") ++index;
      --index;
      continue;
    }
    if (char === "(") ++parentheses;
    if (char === ")") --parentheses;
    const boundary = /[;(&|)\n]/.test(char);
    if (boundary || /\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      if (boundary && words.length > 0) {
        yield words;
        words = [];
      }
      continue;
    }
    word = (word ?? "") + char;
  }
  if (word !== undefined) words.push(word);
  if (words.length > 0) yield words;
  return index;
}
