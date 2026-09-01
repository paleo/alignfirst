// Gateway-side transcript dump, invoked by the runner through the exec-watcher
// RPC: `node transcript-dump.js <sinceIso> <conversationId> <outPath>`.
// OpenClaw 2026.8+ persists each session's transcript as SQLite rows in the
// per-agent store. Unlike the trajectory diagnostics (whose payloads are
// node-capped and redacted), the transcript is the full-fidelity record the
// gateway itself replays, appended per message — tool calls become visible as
// they happen, not at turn end. This script extracts the transcripts of a
// conversation's sessions and writes them as JSON to `outPath` (stdout would
// hit the watcher's 1 MiB cap).
import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface DumpedSession {
  sessionKey: string;
  sessionId: string;
  messages: unknown[];
}

main();

function main(): void {
  const [sinceIso, conversationId, outPath] = process.argv.slice(2);
  if (sinceIso === undefined || conversationId === undefined || outPath === undefined) {
    console.error("usage: transcript-dump.js <sinceIso> <conversationId> <outPath>");
    process.exit(2);
  }
  const sinceMs = Date.parse(sinceIso);
  const databases = findAgentDatabases();
  const sessions = databases.flatMap((dbPath) =>
    readConversationSessions(dbPath, sinceMs, conversationId),
  );
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ databases: databases.length, sessions }));
  renameSync(tmpPath, outPath);
}

function findAgentDatabases(): string[] {
  const agentsDir = join(homedir(), ".openclaw", "agents");
  let agentIds: string[];
  try {
    agentIds = readdirSync(agentsDir);
  } catch {
    return [];
  }
  return agentIds
    .map((id) => join(agentsDir, id, "agent", "openclaw-agent.sqlite"))
    .filter(canOpenDatabase);
}

function canOpenDatabase(path: string): boolean {
  try {
    new DatabaseSync(path, { readOnly: true }).close();
    return true;
  } catch {
    return false;
  }
}

function readConversationSessions(
  dbPath: string,
  sinceMs: number,
  conversationId: string,
): DumpedSession[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    const wanted = conversationId.toLowerCase();
    const nodes = db.prepare("SELECT session_key, current_session_id FROM session_nodes").all() as {
      session_key: string;
      current_session_id: string;
    }[];
    const sessions: DumpedSession[] = [];
    for (const node of nodes) {
      if (!node.session_key.toLowerCase().includes(wanted)) continue;
      sessions.push({
        sessionKey: node.session_key,
        sessionId: node.current_session_id,
        messages: readSessionMessages(db, node.current_session_id, sinceMs),
      });
    }
    return sessions;
  } catch {
    // Fresh store without the tables yet, or a transient lock: the runner's
    // next poll retries.
    return [];
  } finally {
    db.close();
  }
}

function readSessionMessages(db: DatabaseSync, sessionId: string, sinceMs: number): unknown[] {
  const rows = db
    .prepare(
      "SELECT event_json FROM transcript_events WHERE session_id = ? AND created_at >= ? ORDER BY seq",
    )
    .all(sessionId, sinceMs) as { event_json: string }[];
  const messages: unknown[] = [];
  for (const row of rows) {
    let event: { type?: string; message?: unknown };
    try {
      event = JSON.parse(row.event_json) as { type?: string; message?: unknown };
    } catch {
      continue;
    }
    if (event.type === "message" && event.message !== undefined) messages.push(event.message);
  }
  return messages;
}
