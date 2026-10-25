// Gateway-side transcript dump, invoked by the runner through the exec-watcher
// RPC: `node transcript-dump.js <sinceIso> <conversationId> <outPath> [threadId...]
// [--session-key <key>...]`.
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
import { readConversationSessions } from "./transcript-store.js";

main();

function main(): void {
  const [sinceIso, conversationId, outPath, ...rest] = process.argv.slice(2);
  if (sinceIso === undefined || conversationId === undefined || outPath === undefined) {
    console.error(
      "usage: transcript-dump.js <sinceIso> <conversationId> <outPath> [threadId...] [--session-key <key>...]",
    );
    process.exit(2);
  }
  const { threadIds, sessionKeys } = parseSelectors(rest);
  const sinceMs = Date.parse(sinceIso);
  const databases = findAgentDatabases();
  const sessions = databases.flatMap((dbPath) =>
    readConversationSessions(dbPath, sinceMs, conversationId, threadIds, sessionKeys),
  );
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ databases: databases.length, sessions }));
  renameSync(tmpPath, outPath);
}

function parseSelectors(args: string[]): { threadIds: string[]; sessionKeys: string[] } {
  const threadIds: string[] = [];
  const sessionKeys: string[] = [];
  for (let i = 0; i < args.length; ++i) {
    if (args[i] !== "--session-key") {
      threadIds.push(args[i]);
      continue;
    }
    const key = args[++i];
    if (key === undefined) {
      console.error("transcript-dump.js: --session-key expects a value");
      process.exit(2);
    }
    sessionKeys.push(key);
  }
  return { threadIds, sessionKeys };
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
