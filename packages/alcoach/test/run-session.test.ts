import { describe, expect, it } from "vitest";

import {
  buildClaudeArgs,
  buildClaudeEnv,
  createStreamState,
  parseEventLine,
  renderEvent,
  type RunConfig,
} from "../src/run-session.js";

const BASE: RunConfig = {
  prompt: "do it",
  logPath: "/tmp/x.md",
  cwd: "/proj",
  isNew: true,
  isBackground: false,
  skipPermissions: false,
  unset: [],
};

describe("buildClaudeArgs", () => {
  it("uses stream-json and permission-mode auto by default", () => {
    expect(buildClaudeArgs(BASE)).toEqual([
      "do it",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
    ]);
  });

  it("skips permissions, resumes, and sets the model", () => {
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
  it("strips every ALCOACH_* var and the ALCOACH_UNSET names", () => {
    const env = buildClaudeEnv(
      {
        PATH: "/bin",
        ALCOACH_CALLBACK_TOKEN: "secret",
        ALCOACH_RUN_CONFIG: "{}",
        SECRET_KEY: "leak",
        KEEP: "yes",
      },
      ["SECRET_KEY"],
    );
    expect(env.PATH).toBe("/bin");
    expect(env.KEEP).toBe("yes");
    expect(env.ALCOACH_CALLBACK_TOKEN).toBeUndefined();
    expect(env.ALCOACH_RUN_CONFIG).toBeUndefined();
    expect(env.SECRET_KEY).toBeUndefined();
  });
});

describe("renderEvent", () => {
  it("captures the session id from the init event", () => {
    const state = createStreamState();
    const line = parseEventLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1" }),
    );
    expect(renderEvent(line, state)).toBe("[init] session sid-1");
    expect(state.sessionId).toBe("sid-1");
  });

  it("renders assistant text and tool calls", () => {
    const state = createStreamState();
    const event = parseEventLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(renderEvent(event, state)).toBe('hello\n[tool: Bash] {"command":"ls"}');
  });

  it("captures the final result and error flag", () => {
    const state = createStreamState();
    const event = parseEventLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "the answer",
        is_error: false,
        session_id: "sid-2",
      }),
    );
    expect(renderEvent(event, state)).toBeUndefined();
    expect(state.result).toBe("the answer");
    expect(state.isError).toBe(false);
    expect(state.sessionId).toBe("sid-2");
  });

  it("flags an error result", () => {
    const state = createStreamState();
    const event = parseEventLine(
      JSON.stringify({ type: "result", result: "nope", is_error: true }),
    );
    renderEvent(event, state);
    expect(state.isError).toBe(true);
  });
});
