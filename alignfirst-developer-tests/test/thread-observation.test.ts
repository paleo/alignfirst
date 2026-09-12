import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { inspectSession } from "../scripts/inspect-thread.ts";

const SESSION_KEY = "agent:main:discord:channel:thread-1";

test("a terminal in another thread cannot settle an unanswered takeover", () => {
  withTranscript((database, path) => {
    append(database, "target", { role: "user", content: "Take over this thread." });
    append(database, "other", terminal("Done"));
    assert.deepEqual(inspectSession(path, SESSION_KEY), {
      messageCount: 1,
      terminalCount: 0,
      openTurn: true,
    });
    append(database, "target", terminal("NO_REPLY"));
    assert.equal(inspectSession(path, SESSION_KEY).openTurn, false);
  });
});

test("reports process exit and correlated native completion independently", () => {
  withTranscript((database, path) => {
    append(database, "target", {
      role: "toolResult",
      toolCallId: "launch-1",
      content: [
        { type: "text", text: `Command still running (session worker-1, pid ${process.pid}).` },
      ],
    });
    append(database, "target", terminal("Implementation and tests complete."));
    let observed = inspectSession(path, SESSION_KEY, "launch-1");
    assert.equal(observed.processExited, false);
    assert.equal(observed.nativeTurnCompleted, false);

    append(database, "target", { role: "user", content: "[OpenClaw heartbeat poll]" });
    observed = inspectSession(path, SESSION_KEY, "launch-1");
    assert.equal(observed.nativeTurnCompleted, false);
    assert.equal(observed.openTurn, true);
    append(database, "target", terminal("HEARTBEAT_OK"));
    observed = inspectSession(path, SESSION_KEY, "launch-1");
    assert.equal(observed.nativeTurnCompleted, false);
    appendRuntime(database, "other-process", "prompt.submitted", {
      prompt: "Exec completed (other-wo, code 0) :: done",
    });
    appendRuntime(database, "other-process", "session.ended", {
      status: "success",
      stopReason: "stop",
    });
    assert.equal(inspectSession(path, SESSION_KEY, "launch-1").nativeTurnCompleted, false);
    appendRuntime(database, "native-1", "prompt.submitted", {
      prompt: "An async command has finished.\nExec completed (worker-1, code 0) :: done",
    });
    appendRuntime(database, "unrelated", "session.ended", {
      status: "success",
      stopReason: "stop",
    });
    assert.equal(inspectSession(path, SESSION_KEY, "launch-1").nativeTurnCompleted, false);
    appendRuntime(database, "native-1", "session.ended", { status: "success", stopReason: "stop" });
    observed = inspectSession(path, SESSION_KEY, "launch-1");
    assert.equal(observed.nativeTurnCompleted, true);
    assert.equal(observed.processExited, false);
  });
});

test("a finished process alone does not establish delivery of its completion", () => {
  withTranscript((database, path) => {
    append(database, "target", {
      role: "toolResult",
      toolCallId: "launch-1",
      content: [
        { type: "text", text: "Command still running (session worker-1, pid 2147483647)." },
      ],
    });
    append(database, "target", terminal("Done"));
    const observed = inspectSession(path, SESSION_KEY, "launch-1");
    assert.equal(observed.processExited, true);
    assert.equal(observed.nativeTurnCompleted, false);
    assert.equal(observed.terminalPollObserved, false);
    assert.equal(inspectSession(path, SESSION_KEY, "missing").backgroundResultObserved, false);
  });
});

test("reading process logs cannot acknowledge a terminal completion notice", () => {
  withTranscript((database, path) => {
    append(database, "target", {
      role: "toolResult",
      toolCallId: "launch-1",
      content: "Command still running (session worker-1, pid 2147483647).",
    });
    for (const action of ["log", "poll"]) {
      append(database, "target", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: action, arguments: { action, sessionId: "worker-1" } }],
      });
      append(database, "target", {
        role: "toolResult",
        toolName: "process",
        toolCallId: action,
        content: "Process exited with code 0.",
      });
      assert.equal(
        inspectSession(path, SESSION_KEY, "launch-1").terminalPollObserved,
        action === "poll",
      );
    }
  });
});

function withTranscript(run: (database: DatabaseSync, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "alignfirst-thread-observation-"));
  const path = join(directory, "transcript.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE session_windows (session_id TEXT, session_key TEXT);
      CREATE TABLE transcript_events (session_id TEXT, event_json TEXT, created_at INTEGER, seq INTEGER);
      CREATE TABLE trajectory_runtime_events (session_id TEXT, run_id TEXT, event_json TEXT, created_at INTEGER);
    `);
    database.prepare("INSERT INTO session_windows VALUES (?, ?)").run("target", SESSION_KEY);
    database.prepare("INSERT INTO session_windows VALUES (?, ?)").run("other", "other-thread");
    run(database, path);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function append(database: DatabaseSync, sessionId: string, message: object): void {
  database
    .prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)")
    .run(
      sessionId,
      JSON.stringify({ message }),
      Date.now(),
      Number(database.prepare("SELECT COUNT(*) AS n FROM transcript_events").get()?.n),
    );
}

function terminal(text: string) {
  return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}

function appendRuntime(database: DatabaseSync, runId: string, type: string, data: object): void {
  database
    .prepare("INSERT INTO trajectory_runtime_events VALUES (?, ?, ?, ?)")
    .run("target", runId, JSON.stringify({ type, data }), Date.now());
}
