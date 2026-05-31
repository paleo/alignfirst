import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolCall } from "./report.js";

export const TRAJECTORY_DIR = "/home/claw/.openclaw/logs/trajectory";

const MODEL_COMPLETED = "model.completed";

interface TrajectoryEvent {
  ts?: string;
  type?: string;
  sessionKey?: string;
  data?: ModelCompletedData;
}

interface ModelCompletedData {
  messagesSnapshot?: unknown;
  truncated?: boolean;
}

interface ToolResultBlock {
  isError: boolean;
  content?: unknown;
}

/**
 * Polls the trajectory log until a `model.completed` event matching this
 * conversation lands (it flushes ~2-10s after the agent's last bus traffic),
 * or the budget expires. mtime-based "quiescence" doesn't work: the log can
 * stay idle for several seconds *before* the event is written, which a
 * naive heuristic would mistake for "done".
 */
export async function waitForTrajectoryUsage(opts: {
  conversationId: string;
  startedAtIso: string;
  maxWaitMs?: number;
  pollMs?: number;
}): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    // The dir itself appears only when the first delayed event flushes, so a
    // missing dir means "not yet" — keep polling, don't give up early.
    if (trajectoryDirExists()) {
      for (const event of readTrajectoryEvents()) {
        if (isEventFor(event, opts.conversationId, opts.startedAtIso, MODEL_COMPLETED)) return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Cost lives per assistant message inside `messagesSnapshot`, as
 * `usage.cost.total` (the event-level `data.usage` is token counts only, with no
 * cost). The last `model.completed` event holds the cumulative snapshot, so we
 * sum every assistant message's cost there. `turns` counts those messages.
 */
export function readTrajectoryCostFor(opts: { startTsIso: string; conversationId?: string }): {
  cost: number;
  turns: number;
} {
  const last = findLastCompletedEvent({
    conversationId: opts.conversationId ?? "",
    startedAtIso: opts.startTsIso,
  });
  if (last?.data?.truncated === true) {
    console.warn(
      "openclaw-test: last model.completed snapshot is truncated (~256 KB cap); reported cost may be undercounted.",
    );
  }
  const messages = last?.data?.messagesSnapshot;
  if (!Array.isArray(messages)) return { cost: 0, turns: 0 };
  let cost = 0;
  let turns = 0;
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    const total = assistantCostTotal(msg);
    if (typeof total !== "number") continue;
    cost += total;
    turns += 1;
  }
  return { cost, turns };
}

function assistantCostTotal(msg: Record<string, unknown>): number | undefined {
  const usage = msg.usage;
  if (!isRecord(usage)) return;
  const cost = usage.cost;
  if (!isRecord(cost)) return;
  return typeof cost.total === "number" ? cost.total : undefined;
}

/**
 * Parse agent tool calls from the trajectory log filtered by conversationId.
 * We take the LAST `model.completed` event for that session (the most complete
 * transcript) and walk `data.messagesSnapshot`, collecting assistant `toolCall`
 * blocks and matching them with `toolResult` messages.
 *
 * Events are byte-capped by OpenClaw (~256 KB); a large snapshot can be
 * truncated to an unusable shape. `data.usage` is tiny and unaffected, so cost
 * and sync survive. When the snapshot is not a usable array, return `[]`.
 */
export function parseAgentToolCalls(opts: {
  conversationId: string;
  startedAtIso: string;
}): AgentToolCall[] {
  const last = findLastCompletedEvent(opts);
  if (!last) return [];
  const messages = last.data?.messagesSnapshot;
  if (!Array.isArray(messages)) return [];
  const results = collectToolResults(messages);
  return collectToolUses(messages, results, last.ts ?? "");
}

export function trajectoryDirExists(): boolean {
  try {
    return statSync(TRAJECTORY_DIR).isDirectory();
  } catch {
    return false;
  }
}

function readTrajectoryEvents(): TrajectoryEvent[] {
  let files: string[];
  try {
    files = readdirSync(TRAJECTORY_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: TrajectoryEvent[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(TRAJECTORY_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as TrajectoryEvent);
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

function isEventFor(
  event: TrajectoryEvent,
  conversationId: string,
  sinceIso: string,
  type: string,
): boolean {
  if (event.type !== type || !event.ts || event.ts < sinceIso) return false;
  return event.sessionKey?.toLowerCase().includes(conversationId.toLowerCase()) === true;
}

function findLastCompletedEvent(opts: {
  conversationId: string;
  startedAtIso: string;
}): TrajectoryEvent | undefined {
  const matching = readTrajectoryEvents().filter((e) =>
    isEventFor(e, opts.conversationId, opts.startedAtIso, MODEL_COMPLETED),
  );
  if (matching.length === 0) return;
  matching.sort((a, b) => ((a.ts ?? "") < (b.ts ?? "") ? -1 : 1));
  return matching[matching.length - 1];
}

function collectToolResults(messages: unknown[]): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== "toolResult") continue;
    const toolCallId = msg.toolCallId;
    if (typeof toolCallId !== "string") continue;
    results.set(toolCallId, { isError: msg.isError === true, content: msg.content ?? null });
  }
  return results;
}

function collectToolUses(
  messages: unknown[],
  results: Map<string, ToolResultBlock>,
  ts: string,
): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    turn += 1;
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== "toolCall") continue;
      const toolUseId = typeof block.id === "string" ? block.id : "";
      const toolName = typeof block.name === "string" ? block.name : "";
      if (!toolUseId || !toolName) continue;
      const call: AgentToolCall = {
        toolName,
        toolUseId,
        input: block.arguments ?? null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
