import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readConversationSessions } from "../src/transcript-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("conversation transcript attribution", () => {
  it("includes opaque thread sessions and their recovery windows without matching other IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-transcripts-"));
    directories.push(directory);
    const path = join(directory, "agent.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT);
      CREATE TABLE session_windows (session_key TEXT, session_id TEXT, created_at INTEGER);
      CREATE TABLE transcript_events (
        session_id TEXT, created_at INTEGER, seq INTEGER, event_json TEXT, event_zstd BLOB
      );
    `);
    const conversationId = "A14-sole-project-discord-mock-test";
    const threadId = "1544775615678771200";
    const channelKey = `agent:main:discord-mock:channel:${conversationId.toLowerCase()}`;
    const threadKey = `agent:main:discord-mock:channel:${threadId}`;
    seedSession(db, channelKey, "channel", "starter");
    seedSession(db, threadKey, "thread-before-recovery", "claim");
    db.prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?").run(
      "thread-after-recovery",
      threadKey,
    );
    seedWindow(db, threadKey, "thread-after-recovery", "workspace ready", 2, { compressed: true });
    seedSession(db, `${threadKey}1`, "other-thread", "unrelated");
    seedSession(db, `${channelKey}-other`, "other-conversation", "unrelated");
    db.close();

    const sessions = readConversationSessions(path, 0, conversationId, [threadId]);
    expect(sessions.map((session) => session.sessionKey)).toEqual([channelKey, threadKey]);
    expect(sessions[1]).toMatchObject({
      sessionId: "thread-after-recovery",
      messages: [
        { role: "assistant", content: "claim" },
        { role: "assistant", content: "workspace ready" },
      ],
    });
    expect(readConversationSessions(path, 2, conversationId, [threadId])[1]?.messages).toEqual([
      { role: "assistant", content: "workspace ready" },
    ]);
  });
});

function seedSession(db: DatabaseSync, key: string, id: string, text: string): void {
  db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(key, id);
  seedWindow(db, key, id, text, 1);
}

function seedWindow(
  db: DatabaseSync,
  key: string,
  id: string,
  text: string,
  timestamp: number,
  options: { compressed?: boolean } = {},
): void {
  db.prepare("INSERT INTO session_windows VALUES (?, ?, ?)").run(key, id, timestamp);
  const eventJson = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: text },
  });
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)").run(
    id,
    timestamp,
    1,
    options.compressed ? null : eventJson,
    options.compressed ? zstdCompressSync(Buffer.from(eventJson, "utf8")) : null,
  );
}
