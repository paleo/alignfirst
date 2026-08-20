import { describe, expect, it } from "vitest";

import {
  assessClaudeState,
  buildClaudeArgs,
  createClaudeState,
  interpretClaudeLine,
} from "../src/claude-agent.js";
import type { RunConfig } from "../src/run-agent.js";

const BASE: RunConfig = {
  prompt: "do the thing",
  sessionFilePath: "/tmp/x.md",
  cwd: "/proj",
  isNew: true,
  skipPermissions: false,
  unset: [],
  env: {},
};

describe("Claude adapter", () => {
  it("builds exact normal and dangerous argv", () => {
    expect(buildClaudeArgs(BASE)).toEqual([
      "do the thing",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
    ]);
    expect(
      buildClaudeArgs({
        ...BASE,
        skipPermissions: true,
        resume: "sess-9",
        executableModel: "opus",
      }),
    ).toEqual([
      "do the thing",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--resume",
      "sess-9",
      "--model",
      "opus",
    ]);
  });

  it("preserves identity, transcript, result, and auth behavior", () => {
    const state = createClaudeState();
    expect(
      interpretClaudeLine(
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
        state,
      ),
    ).toBe("[init] session sess-1");
    expect(
      interpretClaudeLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
        state,
      ),
    ).toBe("hello");
    interpretClaudeLine(
      JSON.stringify({
        type: "result",
        result: "final answer",
        is_error: false,
        session_id: "sess-1",
      }),
      state,
    );
    expect(assessClaudeState(state)).toMatchObject({
      succeeded: true,
      sessionId: "sess-1",
      result: "final answer",
    });
  });

  it("marks structured authentication failures only as evidence", () => {
    const state = createClaudeState();
    interpretClaudeLine(JSON.stringify({ type: "system", error: "authentication_failed" }), state);
    expect(state.authEvidence).toBe(true);
    expect(assessClaudeState(state).succeeded).toBe(false);
  });
});
