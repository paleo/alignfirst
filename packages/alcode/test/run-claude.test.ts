import { describe, expect, it } from "vitest";

import {
  buildClaudeArgs,
  buildClaudeEnv,
  buildTerminationUpdate,
  createStreamState,
  renderEvent,
  type RunConfig,
} from "../src/run-claude.js";

const BASE: RunConfig = {
  prompt: "do the thing",
  sessionFilePath: "/tmp/x.md",
  cwd: "/proj",
  isNew: true,
  skipPermissions: false,
  unset: [],
};

describe("buildClaudeArgs", () => {
  it("emits the stream-json foreground shape with auto permissions by default", () => {
    const args = buildClaudeArgs(BASE);
    expect(args.slice(0, 5)).toEqual([
      "do the thing",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("switches to skip-permissions and threads resume + model", () => {
    const args = buildClaudeArgs({
      ...BASE,
      skipPermissions: true,
      resume: "sess-9",
      model: "opus",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toEqual(expect.arrayContaining(["--resume", "sess-9", "--model", "opus"]));
    expect(args).not.toContain("--permission-mode");
  });
});

describe("buildClaudeEnv", () => {
  it("strips every ALIGNFIRST_CODE_* var and the ALIGNFIRST_CODE_UNSET names", () => {
    const env = buildClaudeEnv(
      {
        PATH: "/bin",
        ALIGNFIRST_CODE_SKIP_PERMISSIONS: "1",
        ALIGNFIRST_CODE_UNSET: "SECRET_KEY",
        SECRET_KEY: "leak",
        KEEP: "yes",
      },
      ["SECRET_KEY"],
    );
    expect(env.PATH).toBe("/bin");
    expect(env.KEEP).toBe("yes");
    expect(env.ALIGNFIRST_CODE_SKIP_PERMISSIONS).toBeUndefined();
    expect(env.SECRET_KEY).toBeUndefined();
  });
});

describe("buildTerminationUpdate", () => {
  it("seals the session as failed/terminated with the captured session id", () => {
    const state = createStreamState();
    state.sessionId = "sess-1";
    const update = buildTerminationUpdate("SIGTERM", state, new Date("2026-07-02T10:00:00Z"));
    expect(update).toEqual({
      status: "failed",
      endedAt: "2026-07-02T10:00:00.000Z",
      exitReason: "terminated",
      sessionId: "sess-1",
      result: "Terminated by SIGTERM before completion.",
    });
  });

  it("leaves the session id null when the stream never reported one", () => {
    const update = buildTerminationUpdate("SIGINT", createStreamState(), new Date(0));
    expect(update.sessionId).toBeNull();
  });
});

describe("renderEvent", () => {
  it("captures the session id from the init event", () => {
    const state = createStreamState();
    const line = renderEvent({ type: "system", subtype: "init", session_id: "sess-1" }, state);
    expect(state.sessionId).toBe("sess-1");
    expect(line).toContain("sess-1");
  });

  it("renders assistant text and captures the final result", () => {
    const state = createStreamState();
    const text = renderEvent(
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      state,
    );
    expect(text).toBe("hello");
    renderEvent(
      { type: "result", result: "final answer", is_error: false, session_id: "sess-1" },
      state,
    );
    expect(state.result).toBe("final answer");
    expect(state.isError).toBe(false);
  });

  it("flags an error result", () => {
    const state = createStreamState();
    renderEvent({ type: "result", result: "boom", is_error: true }, state);
    expect(state.isError).toBe(true);
  });
});
