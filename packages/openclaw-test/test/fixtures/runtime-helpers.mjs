import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { readConversationSessions } from "../../dist/transcript-store.js";
import { spawnHostProcess } from "../../dist/host-process.js";
import "../../dist/runner.js";
import "../../dist/transcript-log.js";

const dir = mkdtempSync(join(tmpdir(), "harness-runtime-"));
try {
  const path = join(dir, "agent.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT);
      CREATE TABLE session_windows (session_key TEXT, session_id TEXT, created_at INTEGER);
      CREATE TABLE transcript_events (
        session_id TEXT, created_at INTEGER, seq INTEGER, event_json TEXT, event_zstd BLOB
      );
    `);
    const key = "agent:main:discord-mock:channel:offline";
    db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(key, "session");
    db.prepare("INSERT INTO session_windows VALUES (?, ?, ?)").run(key, "session", 1);
    for (const compressed of [false, true]) {
      const event = JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "fixture" },
      });
      db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)").run(
        "session",
        compressed ? 2 : 1,
        compressed ? 2 : 1,
        compressed ? null : event,
        compressed ? zstdCompressSync(Buffer.from(event)) : null,
      );
    }
  } finally {
    db.close();
  }
  assert.deepEqual(readConversationSessions(path, 0, "offline")[0].messages, [
    { role: "assistant", content: "fixture" },
    { role: "assistant", content: "fixture" },
  ]);
  const listeners = process.listenerCount("SIGTERM");
  assert.equal(await spawnHostProcess({ command: join(dir, "missing-command"), argv: [] }), 1);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  console.log("SQLITE_ZSTD_OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
