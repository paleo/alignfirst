import { describe, expect, it } from "vitest";

import {
  assessCodexState,
  buildCodexArgs,
  createCodexAdapter,
  createCodexState,
  interpretCodexLine,
} from "../src/codex-agent.js";
import type { RunConfig } from "../src/run-agent.js";

const BASE: RunConfig = {
  prompt: "do the thing",
  sessionFilePath: "/tmp/x.md",
  cwd: "/proj",
  isNew: true,
  executableModel: undefined,
  skipPermissions: false,
  unset: [],
  env: {},
};

describe("Codex argv", () => {
  it("builds new and resumed commands with normal sandboxing", () => {
    expect(buildCodexArgs(BASE)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "do the thing",
    ]);
    expect(
      buildCodexArgs({ ...BASE, resume: "thread-1", executableModel: "gpt-5.6-terra" }),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5.6-terra",
      "resume",
      "thread-1",
      "do the thing",
    ]);
  });

  it("replaces the sandbox with dangerous bypass", () => {
    expect(buildCodexArgs({ ...BASE, skipPermissions: true })).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "do the thing",
    ]);
  });
});

describe("Codex protocol", () => {
  it("captures messages as the transcript and intentionally omits tool lifecycle items", () => {
    const state = createCodexState();
    const rendered = [
      event(state, { type: "thread.started", thread_id: "thread-1" }),
      event(state, { type: "item.completed", item: { type: "command_execution", command: "pwd" } }),
      event(state, { type: "item.completed", item: { type: "agent_message", text: "first" } }),
      event(state, { type: "item.completed", item: { type: "agent_message", text: "last" } }),
      event(state, { type: "turn.completed", usage: { input_tokens: 1 } }),
    ];
    expect(rendered).toEqual(["[init] session thread-1", undefined, "first", "last", undefined]);
    expect(assessCodexState(state)).toMatchObject({
      succeeded: true,
      sessionId: "thread-1",
      result: "last",
    });
  });

  it("fails on missing completion or missing result", () => {
    const incomplete = createCodexState();
    event(incomplete, { type: "item.completed", item: { type: "agent_message", text: "answer" } });
    expect(assessCodexState(incomplete).succeeded).toBe(false);

    const empty = createCodexState();
    event(empty, { type: "turn.completed" });
    expect(assessCodexState(empty).succeeded).toBe(false);
  });

  it.each([
    { type: "turn.failed", error: { message: "turn broke" } },
    { type: "error", message: "service broke" },
    { type: "item.completed", item: { type: "error", message: "item broke" } },
  ])("preserves structured failures", (failure) => {
    const state = createCodexState();
    expect(event(state, failure)).toMatch(/^\[error\]/);
    expect(assessCodexState(state).error).toMatch(/broke/);
  });

  it("renders malformed lines without establishing success", () => {
    const state = createCodexState();
    expect(interpretCodexLine("not json", state)).toBe("[unparsed] not json");
    expect(assessCodexState(state).succeeded).toBe(false);
  });

  it("recognizes explicit login evidence but not generic authorization or model failures", () => {
    const login = createCodexState();
    event(login, { type: "error", message: "Not logged in. Run codex login." });
    expect(assessCodexState(login).authEvidence).toBe(true);

    for (const message of ["HTTP 401", "403 forbidden", "model is unavailable"]) {
      const state = createCodexState();
      event(state, { type: "error", message });
      expect(assessCodexState(state).authEvidence).toBe(false);
    }
    const adapter = createCodexAdapter();
    expect(adapter.isAuthenticationError("Please run codex login to continue.")).toBe(true);
    expect(adapter.isAuthenticationError("HTTP 401 unauthorized")).toBe(false);
  });

  it("ignores auth-looking assistant text when the run recovers", () => {
    const state = createCodexState();
    event(state, {
      type: "item.completed",
      item: { type: "agent_message", text: "Not logged in, but this is ordinary output" },
    });
    event(state, { type: "turn.completed" });
    expect(assessCodexState(state)).toMatchObject({ succeeded: true, authEvidence: false });
  });
});

function event(state: ReturnType<typeof createCodexState>, value: unknown): string | undefined {
  return interpretCodexLine(JSON.stringify(value), state);
}
