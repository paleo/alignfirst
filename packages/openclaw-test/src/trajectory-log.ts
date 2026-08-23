import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolCall } from "./report.js";

export const TRAJECTORY_DIR = "/home/claw/.openclaw/logs/trajectory";

const MODEL_COMPLETED = "model.completed";

export interface TrajectoryEvent {
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
 * Polls the trajectory log until it is *quiescent* for this conversation — no
 * new `model.completed` event has appeared for `settleMs` — or the budget
 * expires. A conversation spans multiple OpenClaw sessions (e.g. Discord's
 * channel session plus a per-thread session), and each flushes its own
 * `model.completed` ~2-10s after its last turn. Returning on the first event
 * would miss a late-flushing session, so we wait for the count to stabilise.
 */
export async function waitForTrajectoryUsage(opts: {
  conversationId: string;
  startedAtIso: string;
  maxWaitMs?: number;
  pollMs?: number;
  settleMs?: number;
}): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 20_000;
  const pollMs = opts.pollMs ?? 250;
  const settleMs = opts.settleMs ?? 4_000;
  const deadline = Date.now() + maxWaitMs;
  let lastCount = 0;
  let lastChangeAt = Date.now();
  let seenAny = false;
  while (Date.now() < deadline) {
    // The dir itself appears only when the first delayed event flushes, so a
    // missing dir means "not yet" — keep polling, don't give up early.
    if (trajectoryDirExists()) {
      const count = conversationCompletedEvents(opts).length;
      if (count > 0) seenAny = true;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      } else if (seenAny && Date.now() - lastChangeAt >= settleMs) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Cost lives per assistant message inside `messagesSnapshot`, as
 * `usage.cost.total` (the event-level `data.usage` is token counts only, with no
 * cost). A conversation spans several sessions; each session's latest
 * `model.completed` holds that session's cumulative snapshot, so we sum every
 * assistant message's cost across the per-session latest events. `turns` counts
 * those messages.
 */
export function readTrajectoryCostFor(opts: { startTsIso: string; conversationId?: string }): {
  cost: number;
  turns: number;
} {
  const events = conversationCompletedEvents({
    conversationId: opts.conversationId ?? "",
    startedAtIso: opts.startTsIso,
  });
  if (pickNewestPerSession(events).some((e) => e.data?.truncated === true)) {
    console.warn(
      "openclaw-test: a model.completed snapshot is truncated (~256 KB cap); reported cost may be undercounted.",
    );
  }
  return aggregateCost(latestCompletedPerSession(events));
}

/** Sum assistant-message cost and count turns across the given snapshots. */
export function aggregateCost(sessions: TrajectoryEvent[]): { cost: number; turns: number } {
  let cost = 0;
  let turns = 0;
  for (const last of sessions) {
    const messages = last.data?.messagesSnapshot;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (!isRecord(msg) || msg.role !== "assistant") continue;
      const total = assistantCostTotal(msg);
      if (typeof total !== "number") continue;
      cost += total;
      turns += 1;
    }
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
 * A conversation spans multiple sessions (channel, thread, subagents), each its
 * own trajectory file with its own cumulative `messagesSnapshot`. We take each
 * session's latest `model.completed` (the most complete transcript for it),
 * walk `data.messagesSnapshot` collecting assistant `toolCall` blocks matched
 * with `toolResult` messages, then union across sessions deduped by
 * `toolUseId`.
 *
 * Events are byte-capped by OpenClaw (~256 KB); a large snapshot can be
 * truncated to an unusable shape. When a session's newest event is capped, its
 * newest *usable* snapshot stands in (see `latestCompletedPerSession`), so only
 * the calls past the cap are lost rather than the whole session.
 */
export function parseAgentToolCalls(opts: {
  conversationId: string;
  startedAtIso: string;
}): AgentToolCall[] {
  return aggregateAgentToolCalls(latestCompletedPerSession(conversationCompletedEvents(opts)));
}

/** Union tool calls across the given snapshots, deduped by `toolUseId`. */
export function aggregateAgentToolCalls(sessions: TrajectoryEvent[]): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  const seen = new Set<string>();
  for (const last of sessions) {
    const messages = last.data?.messagesSnapshot;
    if (!Array.isArray(messages)) continue;
    const results = collectToolResults(messages);
    for (const call of collectToolUses(messages, results, last.ts ?? "", last.sessionKey)) {
      if (seen.has(call.toolUseId)) continue;
      seen.add(call.toolUseId);
      calls.push(call);
    }
  }
  return calls;
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

/** All `model.completed` events for the conversation, from every session file. */
function conversationCompletedEvents(opts: {
  conversationId: string;
  startedAtIso: string;
}): TrajectoryEvent[] {
  return readTrajectoryEvents().filter((e) =>
    isEventFor(e, opts.conversationId, opts.startedAtIso, MODEL_COMPLETED),
  );
}

/**
 * The newest usable `model.completed` per session (`sessionKey`). Within one
 * session the snapshot is cumulative, so newer is fuller — but OpenClaw
 * byte-caps events (~256 KB), and a capped event's snapshot parses to an
 * unusable shape. Falling back to the newest event whose snapshot is a real
 * array keeps the session's earlier calls visible instead of dropping the
 * whole session; only the tail past the cap is lost. A session with no usable
 * snapshot contributes its newest event, which the aggregators skip.
 */
export function latestCompletedPerSession(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const usableBySession = new Map(
    pickNewestPerSession(events.filter(hasUsableSnapshot)).map((e) => [e.sessionKey ?? "", e]),
  );
  return pickNewestPerSession(events).map((e) => usableBySession.get(e.sessionKey ?? "") ?? e);
}

function pickNewestPerSession(events: TrajectoryEvent[]): TrajectoryEvent[] {
  const bySession = new Map<string, TrajectoryEvent>();
  for (const e of events) {
    const key = e.sessionKey ?? "";
    const prev = bySession.get(key);
    if (!prev || (prev.ts ?? "") < (e.ts ?? "")) bySession.set(key, e);
  }
  return [...bySession.values()];
}

function hasUsableSnapshot(e: TrajectoryEvent): boolean {
  return Array.isArray(e.data?.messagesSnapshot);
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
  sessionKey: string | undefined,
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
        ...(sessionKey !== undefined ? { sessionKey } : {}),
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
