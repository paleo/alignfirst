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
  executableModel: undefined,
  skipPermissions: false,
  unset: [],
  env: {},
};

describe("Claude adapter", () => {
  it("builds exact normal and dangerous argv", () => {
    expect(buildClaudeArgs(BASE)).toEqual([
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

  it("propagates an error result as the failure", () => {
    const state = createClaudeState();
    interpretClaudeLine(
      JSON.stringify({
        type: "result",
        result: "Claude could not complete the task",
        is_error: true,
      }),
      state,
    );
    expect(assessClaudeState(state)).toMatchObject({
      succeeded: false,
      result: "Claude could not complete the task",
      error: "Claude could not complete the task",
    });
  });

  it("measures the context window from the newest main-loop response", () => {
    const state = createClaudeState();
    assistant(state, { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 });
    assistant(state, {
      input_tokens: 12,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 120_000,
      output_tokens: 300,
    });
    expect(assessClaudeState(state).contextTokens).toBe(125_312);
  });

  it("ignores subagent responses, which hold their own context", () => {
    const state = createClaudeState();
    assistant(state, { input_tokens: 1_000, output_tokens: 10 });
    interpretClaudeLine(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        message: { content: [], usage: { input_tokens: 900_000, output_tokens: 10 } },
      }),
      state,
    );
    expect(assessClaudeState(state).contextTokens).toBe(1_010);
  });

  it("reports no context when the stream carries no usage", () => {
    const state = createClaudeState();
    interpretClaudeLine(JSON.stringify({ type: "assistant", message: { content: [] } }), state);
    expect(assessClaudeState(state).contextTokens).toBeUndefined();
  });
});

function assistant(
  state: ReturnType<typeof createClaudeState>,
  usage: Record<string, number>,
): void {
  interpretClaudeLine(
    JSON.stringify({ type: "assistant", message: { content: [], usage } }),
    state,
  );
}
