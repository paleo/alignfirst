import { describe, expect, it } from "vitest";

import { createPiAdapter } from "../../src/code/pi-agent.js";
import type { RunConfig } from "../../src/code/run-agent.js";

const BASE: RunConfig = {
  prompt: "literal prompt",
  sessionFilePath: "/tmp/run.md",
  cwd: "/project",
  executableModel: undefined,
  skipPermissions: false,
  additionalDirectories: [],
  unset: [],
  env: {},
};
const HEADER = {
  type: "session",
  version: 3,
  id: "session-1",
  cwd: "/project",
  timestamp: "2026-10-17T00:00:00Z",
};
const USAGE = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 };

function fixture(config: RunConfig = BASE) {
  const adapter = createPiAdapter();
  const state = adapter.createState(config);
  const emit = (event: unknown) => adapter.interpretLine(JSON.stringify(event), state);
  const message = (stopReason = "stop", text = "final answer", extra: object = {}) =>
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason,
        content: [{ type: "text", text }],
        usage: USAGE,
        ...extra,
      },
    });
  const settle = (aborted = false) => emit({ type: "agent_settled", aborted });
  const assess = () => adapter.assess(state);
  return { adapter, state, emit, message, settle, assess };
}

describe("pi adapter", () => {
  it("builds new and exact resume argv without permission, trust or directory flags", () => {
    const { adapter } = fixture();
    expect(adapter.buildArgs(BASE)).toEqual(["--mode", "json"]);
    expect(
      adapter.buildArgs({
        ...BASE,
        resume: "full-session-id",
        executableModel: "provider/model:high",
        skipPermissions: true,
        additionalDirectories: ["/companion"],
      }),
    ).toEqual(["--mode", "json", "--model", "provider/model:high", "--session", "full-session-id"]);
  });

  it("renders authoritative text once, concise tools and the final meaningful message", () => {
    const f = fixture();
    expect(f.emit(HEADER)).toBe("[init] session session-1");
    expect(
      f.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    ).toBeUndefined();
    expect(f.message("toolUse", "Checking the files")).toBe("Checking the files");
    expect(
      f.emit({
        type: "tool_execution_start",
        toolCallId: "t",
        toolName: "read",
        args: { path: "secret" },
      }),
    ).toBe("[tool: read] start");
    expect(
      f.emit({
        type: "tool_execution_end",
        toolName: "read",
        isError: true,
        result: { text: "private tool output" },
      }),
    ).toBe("[tool: read] error");
    expect(f.message()).toBe("final answer");
    f.emit({ type: "future_event", detail: true });
    f.emit({ type: "agent_end", messages: [], willRetry: false });
    expect(f.assess().succeeded).toBe(false);
    f.settle();
    expect(f.assess()).toMatchObject({
      succeeded: true,
      sessionId: "session-1",
      result: "final answer",
    });
  });

  it("accepts an exact resumed header and rejects a different identity without claiming resume", () => {
    for (const id of ["session-1", "forked-id"]) {
      const f = fixture({ ...BASE, resume: "session-1" });
      f.emit({ ...HEADER, id });
      f.message();
      f.settle();
      expect(f.assess().succeeded).toBe(id === "session-1");
      if (id !== "session-1") {
        expect(f.assess().error).toContain("differs from session-1");
        expect(f.assess().sessionId).toBeUndefined();
      }
    }
  });

  it.each(["error", "aborted", "length", "pending", "deferred", "toolUse"])(
    "fails a settled final %s even after an earlier good answer",
    (reason) => {
      const f = fixture();
      f.emit(HEADER);
      f.message();
      f.message(reason, "partial result");
      f.settle();
      expect(f.assess().succeeded).toBe(false);
      expect(f.assess().error).toContain(reason);
    },
  );

  it("requires a nonblank final result rather than reusing earlier commentary", () => {
    const f = fixture();
    f.emit(HEADER);
    f.message();
    f.message("stop", " \n ");
    f.settle();
    expect(f.assess()).toMatchObject({ succeeded: false, result: undefined });
    expect(f.assess().error).toContain("meaningful final");
  });

  it("rejects settled abort and later activity without a new settlement", () => {
    const f = fixture();
    f.emit(HEADER);
    f.message();
    f.settle(true);
    expect(f.assess().succeeded).toBe(false);
    f.settle();
    expect(f.assess().succeeded).toBe(true);
    f.emit({ type: "agent_start" });
    expect(f.assess().error).toContain("before agent_settled");
  });

  it.each([
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", stopReason: "pending" } },
  ])("requires a fresh authoritative assistant after new work starts: %j", (event) => {
    const f = fixture();
    f.emit(HEADER);
    f.message();
    f.settle();
    f.emit(event);
    f.settle();
    expect(f.assess().succeeded).toBe(false);
    expect(f.assess().result).toBeUndefined();
  });

  it("recovers intermediate provider errors and failed retry evidence with a later settled answer", () => {
    const f = fixture();
    f.emit(HEADER);
    f.message("error", "", { errorMessage: "No API key found for example." });
    f.emit({ type: "agent_end", willRetry: true });
    f.emit({ type: "auto_retry_start", attempt: 1 });
    f.emit({ type: "auto_retry_end", success: false, finalError: "temporarily unavailable" });
    f.message();
    f.settle();
    expect(f.assess()).toMatchObject({ succeeded: true, authEvidence: false, error: undefined });
  });

  it.each([
    "missing header",
    "missing assistant",
    "missing settlement",
    "invalid JSON",
    "nonobject",
    "invalid header",
    "duplicate header",
    "invalid message",
    "invalid content",
    "invalid settled",
    "unknown stop reason",
  ])("fails incomplete or invalid required records: %s", (problem) => {
    const f = fixture();
    if (problem !== "missing header") f.emit(HEADER);
    if (problem !== "missing assistant") f.message();
    if (problem === "invalid JSON") f.adapter.interpretLine("{", f.state);
    if (problem === "nonobject") f.emit([]);
    if (problem === "invalid header") f.emit({ ...HEADER, version: 2 });
    if (problem === "duplicate header") f.emit(HEADER);
    if (problem === "invalid message") f.emit({ type: "message_end" });
    if (problem === "invalid content")
      f.message("stop", "", { content: [{ type: "text", text: 3 }] });
    if (problem === "unknown stop reason") f.message("futureReason");
    if (problem !== "missing settlement") f.settle();
    if (problem === "invalid settled") f.emit({ type: "agent_settled" });
    expect(f.assess().succeeded).toBe(false);
    expect(f.assess().error).toBeDefined();
  });

  it.each([
    "No API key found for openai.",
    "Authentication failed for \"openai\". Run '/login openai' to re-authenticate.",
  ])(
    "classifies recognized credential failures in failed assistant/startup channels: %s",
    (errorMessage) => {
      const f = fixture();
      f.emit(HEADER);
      f.message("error", "", { errorMessage });
      f.settle();
      expect(f.assess()).toMatchObject({ succeeded: false, authEvidence: true });
      expect(f.adapter.isAuthenticationError(errorMessage)).toBe(true);
      expect(f.adapter.authenticationMessage(errorMessage)).toContain("/login <provider>");
      expect(f.adapter.authenticationMessage()).not.toContain("codex");
    },
  );

  it.each([
    "Run /login if needed",
    "Model is ambiguous; use --provider",
    "Documentation mentions /login",
    "Tool said: No API key found for openai.",
  ])("does not classify generic diagnostics as authentication: %s", (text) => {
    expect(fixture().adapter.isAuthenticationError(text)).toBe(false);
  });

  it("ignores authentication words in successful text, tool errors and custom messages", () => {
    const f = fixture();
    f.emit(HEADER);
    const errorMessage = "No API key found for openai.";
    f.emit({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: errorMessage },
    });
    f.emit({ type: "message_end", message: { role: "toolResult", errorMessage } });
    f.message("stop", errorMessage);
    f.settle();
    expect(f.assess()).toMatchObject({ succeeded: true, authEvidence: false });
  });

  it("counts only the latest main assistant usage, including cached input once", () => {
    const f = fixture();
    f.emit(HEADER);
    f.message("toolUse", "working", {
      usage: { input: 9000, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    f.emit({ type: "message_update", usage: { ...USAGE, input: 900_000 } });
    f.emit({ type: "message_end", message: { role: "toolResult", usage: { input: 900_000 } } });
    f.message("stop", "answer", {
      usage: { ...USAGE, totalTokens: 10000, reasoning: 10, cacheWrite1h: 20 },
    });
    f.settle();
    expect(f.assess()).toMatchObject({
      contextTokens: 460,
      contextCompacted: false,
      contextTokensError: undefined,
    });
  });

  it.each([undefined, {}, { input: 5 }, { ...USAGE, output: -1 }, { ...USAGE, input: "5" }])(
    "does not retain stale occupancy when latest usage is unavailable: %j",
    (usage) => {
      const f = fixture();
      f.emit(HEADER);
      f.message();
      f.message("stop", "answer", { usage });
      f.settle();
      expect(f.assess()).toMatchObject({ succeeded: true, contextTokens: undefined });
      expect(f.assess().contextTokensError).toContain("latest assistant");
    },
  );

  it("records only successful explicit compaction without using summary usage", () => {
    const f = fixture();
    f.emit(HEADER);
    f.message();
    for (const event of [
      { type: "compaction_end", aborted: true },
      { type: "compaction_end", aborted: false, errorMessage: "failed" },
    ]) {
      f.emit(event);
      expect(f.assess().contextCompacted).toBe(false);
    }
    f.emit({
      type: "compaction_end",
      aborted: false,
      result: { summary: "summary", usage: { input: 900_000 } },
    });
    f.settle();
    expect(f.assess()).toMatchObject({ contextTokens: 460, contextCompacted: true });
  });
});
