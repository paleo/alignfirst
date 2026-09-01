import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { execInGateway, IPC_DIR } from "./exec-rpc.js";
import type { AgentToolCall } from "./report.js";

// OpenClaw persists each session's transcript as SQLite rows in the gateway's
// per-agent store — the full-fidelity record the gateway itself replays,
// appended per message. That store lives outside the shared mounts, so the
// runner extracts a conversation's session transcripts through the
// exec-watcher RPC: the dump script (shipped in this package's dist, mounted
// into the gateway) writes them as JSON into the shared IPC volume.
const DUMP_SCRIPT = "/opt/openclaw-test/src/dist/transcript-dump.js";

export interface TranscriptSnapshot {
  /** Agent stores found in the gateway. 0 means no store yet — or none at all. */
  databases: number;
  sessions: TranscriptSession[];
}

export interface TranscriptSession {
  sessionKey: string;
  sessionId: string;
  /** OpenClaw's neutral message shape: assistant `toolCall` blocks, `toolResult` messages. */
  messages: unknown[];
}

interface ToolResultBlock {
  isError: boolean;
  content?: unknown;
}

/** The transcripts of every session whose key carries the conversation id. */
export async function fetchTranscriptSnapshot(opts: {
  conversationId: string;
  startedAtIso: string;
}): Promise<TranscriptSnapshot> {
  const outPath = `${IPC_DIR}/${randomUUID()}.transcript.json`;
  try {
    const result = await execInGateway([
      "node",
      DUMP_SCRIPT,
      opts.startedAtIso,
      opts.conversationId,
      outPath,
    ]);
    if (result.exitCode !== 0) {
      console.warn(
        `openclaw-test: transcript dump failed (exit ${result.exitCode}): ${result.stderr}`,
      );
      return { databases: 0, sessions: [] };
    }
    const raw = readFileSync(outPath, "utf8");
    return JSON.parse(raw) as TranscriptSnapshot;
  } catch (err) {
    console.warn(`openclaw-test: transcript dump failed: ${String(err)}`);
    return { databases: 0, sessions: [] };
  } finally {
    rmSync(outPath, { force: true });
  }
}

/**
 * Polls the transcripts until they are *quiescent* for this conversation — no
 * new message has appeared for `settleMs` — or the budget expires. A
 * conversation spans multiple OpenClaw sessions (e.g. Discord's channel
 * session plus a per-thread session); waiting for the count to stabilise lets
 * a still-flushing turn land its final assistant message (which carries the
 * turn's usage) before the report is written.
 */
export async function waitForTranscriptQuiescence(opts: {
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
    const { sessions } = await fetchTranscriptSnapshot(opts);
    const count = sessions.reduce((sum, s) => sum + s.messages.length, 0);
    if (count > 0) seenAny = true;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (seenAny && Date.now() - lastChangeAt >= settleMs) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Cost lives per assistant message, as `usage.cost.total`. Sum across every
 * session of the conversation; `turns` counts the cost-bearing messages.
 */
export function readTranscriptCost(snapshot: TranscriptSnapshot): {
  cost: number;
  turns: number;
} {
  let cost = 0;
  let turns = 0;
  for (const session of snapshot.sessions) {
    for (const msg of session.messages) {
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

/** One-shot fetch + aggregation of the conversation's agent tool calls. */
export async function parseAgentToolCalls(opts: {
  conversationId: string;
  startedAtIso: string;
}): Promise<AgentToolCall[]> {
  const { sessions } = await fetchTranscriptSnapshot(opts);
  return aggregateAgentToolCalls(sessions);
}

/**
 * Walk each session's messages collecting assistant `toolCall` blocks matched
 * with `toolResult` messages, then union across sessions deduped by
 * `toolUseId`.
 */
export function aggregateAgentToolCalls(sessions: TranscriptSession[]): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const results = collectToolResults(session.messages);
    for (const call of collectToolUses(session.messages, results, session.sessionKey)) {
      if (seen.has(call.toolUseId)) continue;
      seen.add(call.toolUseId);
      calls.push(call);
    }
  }
  return calls;
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
        startedAt: messageTimestampIso(msg) ?? "",
        turn,
      };
      const result = results.get(toolUseId);
      if (result) call.result = result;
      calls.push(call);
    }
  }
  return calls;
}

function messageTimestampIso(msg: Record<string, unknown>): string | undefined {
  const ts = msg.timestamp;
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string") return ts;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
