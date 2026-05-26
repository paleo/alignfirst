import { readFileSync, statSync } from "node:fs";
import type { AgentToolCall } from "./report.js";

const GATEWAY_LOG_PATH = "/home/claw/.openclaw/logs/anthropic-payload.jsonl";

export { GATEWAY_LOG_PATH };

interface GatewayLogEntry {
  ts?: string;
  stage?: string;
  sessionKey?: string;
  payload?: { messages?: Array<{ role: string; content: unknown }> };
  usage?: { cost?: { total?: number } };
}

interface ToolResultBlock {
  isError: boolean;
  content?: unknown;
  truncatedContent?: string;
}

const CONTENT_TRUNCATE_AT = 60;

function buildResultBlock(isError: boolean, content: unknown): ToolResultBlock {
  if (typeof content === "string" && content.length > CONTENT_TRUNCATE_AT) {
    return {
      isError,
      truncatedContent: `${content.slice(0, CONTENT_TRUNCATE_AT).replace(/\s+$/, "")}…`,
    };
  }
  return { isError, content: content ?? null };
}

/**
 * Polls the gateway log until a `stage:"usage"` entry matching this
 * conversation lands (it flushes ~2-10s after the agent's last bus traffic),
 * or the budget expires. mtime-based "quiescence" doesn't work: the log can
 * stay idle for several seconds *before* the usage record is written, which
 * the previous heuristic mistook for "done".
 */
export async function waitForGatewayUsage(opts: {
  conversationId: string;
  startedAtIso: string;
  maxWaitMs?: number;
  pollMs?: number;
}): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!gatewayLogExists()) return;
    for (const entry of readGatewayLog()) {
      if (!isUsageEntryFor(entry, opts.conversationId, opts.startedAtIso)) continue;
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function readGatewayCostFor(opts: { startTsIso: string; conversationId?: string }): {
  cost: number;
  turns: number;
} {
  let cost = 0;
  let turns = 0;
  for (const entry of readGatewayLog()) {
    if (entry.stage !== "usage" || !entry.ts || entry.ts < opts.startTsIso) continue;
    if (
      opts.conversationId &&
      !entry.sessionKey?.toLowerCase().includes(opts.conversationId.toLowerCase())
    )
      continue;
    const total = entry.usage?.cost?.total;
    if (typeof total === "number") {
      cost += total;
      turns += 1;
    }
  }
  return { cost, turns };
}

/**
 * Parse agent tool calls from the gateway payload log filtered by conversationId.
 * We take the LAST `request` entry for that session (the most complete transcript)
 * and walk its messages, collecting assistant `tool_use` blocks and matching them
 * with `tool_result` blocks from subsequent user messages.
 */
export function parseAgentToolCalls(opts: {
  conversationId: string;
  startedAtIso: string;
}): AgentToolCall[] {
  const last = findLastRequestEntry(opts);
  if (!last) return [];
  const messages = last.payload?.messages ?? [];
  const results = collectToolResults(messages);
  return collectToolUses(messages, results, last.ts ?? "");
}

export function gatewayLogExists(): boolean {
  try {
    statSync(GATEWAY_LOG_PATH);
    return true;
  } catch {
    return false;
  }
}

function readGatewayLog(): GatewayLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(GATEWAY_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const out: GatewayLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as GatewayLogEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function isUsageEntryFor(
  entry: GatewayLogEntry,
  conversationId: string,
  startedAtIso: string,
): boolean {
  if (entry.stage !== "usage" || !entry.ts || entry.ts < startedAtIso) return false;
  return entry.sessionKey?.toLowerCase().includes(conversationId.toLowerCase()) === true;
}

function findLastRequestEntry(opts: {
  conversationId: string;
  startedAtIso: string;
}): GatewayLogEntry | undefined {
  const matching = readGatewayLog().filter(
    (e) =>
      e.ts !== undefined &&
      e.ts >= opts.startedAtIso &&
      e.sessionKey?.toLowerCase().includes(opts.conversationId.toLowerCase()) === true &&
      e.stage === "request" &&
      e.payload?.messages !== undefined,
  );
  if (matching.length === 0) return;
  matching.sort((a, b) => ((a.ts ?? "") < (b.ts ?? "") ? -1 : 1));
  return matching[matching.length - 1];
}

function collectToolResults(
  messages: Array<{ role: string; content: unknown }>,
): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.set(block.tool_use_id, buildResultBlock(block.is_error === true, block.content));
      }
    }
  }
  return results;
}

function collectToolUses(
  messages: Array<{ role: string; content: unknown }>,
  results: Map<string, ToolResultBlock>,
  ts: string,
): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    turn += 1;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type !== "tool_use") continue;
      const toolUseId = typeof block.id === "string" ? block.id : "";
      const toolName = typeof block.name === "string" ? block.name : "";
      if (!toolUseId || !toolName) continue;
      const call: AgentToolCall = {
        toolName,
        toolUseId,
        input: block.input ?? null,
        startedAt: ts,
        turn,
      };
      const result = results.get(toolUseId);
      if (result) call.result = result;
      calls.push(call);
    }
  }
  return calls;
}
