import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Codex writes one rollout per thread under `$CODEX_HOME/sessions/<year>/<month>/<day>/`. The plain
// file is `rollout-<timestamp>-<threadId>.jsonl`; a compacted thread appends `_<uuid>`.
const SESSIONS_DIR = "sessions";
const ROLLOUT_PREFIX = "rollout-";
const ROLLOUT_SUFFIX = ".jsonl";

export interface CodexContextReading {
  // Occupancy of the context window when the run ended, or null when it could not be established.
  contextTokens: number | null;
  // The thread was compacted during the run, so the figure above no longer covers the whole
  // conversation: earlier work now survives only as a summary.
  compacted: boolean;
  // Why no figure could be established. Set together with a null `contextTokens`.
  error?: string;
}

/**
 * Context-window occupancy of a finished Codex run, read from its rollout file.
 *
 * `codex exec --json` reports only cumulative totals: the `usage` of its `turn.completed` event
 * sums every model request of the thread, so it passes the context window on any run with a few
 * tool calls. The rollout holds the figure Codex itself uses for "% context left" —
 * `last_token_usage`, the newest request's occupancy.
 *
 * `streamTotal` is the total taken from that `turn.completed` event. The rollout's own total must
 * equal it, which pins the file to this run and turns any change in the Codex format into a
 * reported error rather than a plausible wrong number.
 */
export function readCodexContext(
  threadId: string | undefined,
  streamTotal: number | undefined,
): CodexContextReading {
  if (threadId === undefined || threadId === "") return failed("Codex reported no thread id.");
  if (streamTotal === undefined) return failed("Codex reported no turn.completed usage.");
  const path = findRolloutPath(threadId);
  if (path === undefined) return failed(`No Codex rollout found for thread ${threadId}.`);
  const records = readUsageRecords(path);
  if (records.length === 0) return failed(`No token_count record in ${basename(path)}.`);
  const last = records[records.length - 1];
  if (last.total !== streamTotal) {
    return failed(
      `Codex rollout total ${last.total} does not match the stream total ${streamTotal}; ` +
        "the rollout format may have changed.",
    );
  }
  // Occupancy only ever falls when Codex compacts the thread, so an earlier reading above the
  // final one is the compaction itself. Matching the rollout's compaction records instead would be
  // brittle: they sit nested inside response items, not as their own event type.
  const peak = Math.max(...records.map((record) => record.occupancy));
  return { contextTokens: last.occupancy, compacted: peak > last.occupancy };
}

function failed(error: string): CodexContextReading {
  return { contextTokens: null, compacted: false, error };
}

function findRolloutPath(threadId: string): string | undefined {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), SESSIONS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return;
  }
  const matches = entries.filter((entry) => matchesThread(basename(entry), threadId)).sort();
  // Timestamps sort lexically, so the last match is the newest rollout of the thread.
  const newest = matches[matches.length - 1];
  return newest === undefined ? undefined : join(root, newest);
}

function matchesThread(name: string, threadId: string): boolean {
  return (
    name.startsWith(ROLLOUT_PREFIX) && name.endsWith(ROLLOUT_SUFFIX) && name.includes(threadId)
  );
}

interface UsageRecord {
  // Context held by the newest model request, from `last_token_usage`.
  occupancy: number;
  // Cumulative thread total, from `total_token_usage`. Compared against the stream.
  total: number;
}

function readUsageRecords(path: string): UsageRecord[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    const record = parseUsageRecord(line);
    if (record !== undefined) records.push(record);
  }
  return records;
}

function parseUsageRecord(line: string): UsageRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const payload = parsed.payload;
  if (!isRecord(payload) || payload.type !== "token_count") return;
  const info = payload.info;
  if (!isRecord(info)) return;
  const occupancy = sumUsage(info.last_token_usage);
  const total = sumUsage(info.total_token_usage);
  if (occupancy === undefined || total === undefined) return;
  return { occupancy, total };
}

// Codex counts cached input inside `input_tokens`, so adding `cached_input_tokens` would double it.
function sumUsage(usage: unknown): number | undefined {
  if (!isRecord(usage)) return;
  return asCount(usage.input_tokens) + asCount(usage.output_tokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
