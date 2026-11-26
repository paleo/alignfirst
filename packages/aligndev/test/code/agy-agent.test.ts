import { describe, expect, it } from "vitest";

import { createAgyAdapter } from "../../src/code/agy-agent.js";
import type { RunConfig } from "../../src/code/run-agent.js";

const adapter = createAgyAdapter();
const BASE: RunConfig = {
  prompt: "do the thing",
  sessionFilePath: "/tmp/x.md",
  authenticationFailure: "login instructions",
  cwd: "/proj",
  executableModel: undefined,
  effort: undefined,
  skipPermissions: false,
  additionalDirectories: [],
  env: {},
};
const STREAM_FLAGS = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--disable-slash-commands",
];

describe("Antigravity argv", () => {
  it.each<[string, Partial<RunConfig>, string[]]>([
    ["a normal run", {}, []],
    ["skipPermissions", { skipPermissions: true }, ["--dangerously-skip-permissions"]],
    [
      "a companion directory",
      { additionalDirectories: ["/companions/proj"] },
      ["--add-dir", "/companions/proj"],
    ],
    ["a resume", { resume: "conv-1" }, ["--conversation", "conv-1"]],
    [
      "a model with an effort",
      { executableModel: "gemini-3.8-flash", effort: "low" },
      ["--model", "gemini-3.8-flash", "--effort", "low"],
    ],
    [
      "every option",
      {
        skipPermissions: true,
        additionalDirectories: ["/companions/proj"],
        resume: "conv-1",
        executableModel: "gemini-3.8-flash",
        effort: "high",
      },
      [
        "--dangerously-skip-permissions",
        "--add-dir",
        "/companions/proj",
        "--conversation",
        "conv-1",
        "--model",
        "gemini-3.8-flash",
        "--effort",
        "high",
      ],
    ],
  ])("builds the stream-json argv for %s", (_name, config, options) => {
    expect(adapter.buildArgs({ ...BASE, ...config })).toEqual([...STREAM_FLAGS, ...options]);
  });
});

describe("Antigravity input", () => {
  it("sends the prompt as one user event line", () => {
    const prompt = 'Say "hi"\nthen\tstop \\ now';
    const input = adapter.formatInput?.({ ...BASE, prompt });
    expect(input?.endsWith("\n")).toBe(true);
    expect(input?.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(input ?? "")).toEqual({ event: "user", message: { content: prompt } });
  });

  // Antigravity's shell starts in the added directory that sorts first, here before `/proj`.
  it("names the working directory when an added directory can take its place", () => {
    const input = adapter.formatInput?.({ ...BASE, additionalDirectories: ["/main/.git"] });
    const { content } = JSON.parse(input ?? "").message;
    expect(content).toContain("`/proj`");
    expect(content.endsWith(`\n\n${BASE.prompt}`)).toBe(true);
  });
});

describe("Antigravity stream", () => {
  it("captures the session, the result and the latest occupancy of a successful run", () => {
    const state = adapter.createState(BASE);
    for (const event of [
      init("conv-1"),
      response("conv-1", 1, "ACTIVE", "I will "),
      response("conv-1", 1, "ACTIVE", "list files."),
      response("conv-1", 1, "DONE", undefined, {
        input_tokens: 10987,
        output_tokens: 68,
        thinking_tokens: 40,
        cache_read_tokens: 0,
        total_tokens: 11095,
      }),
      tool("conv-1", 2, "ACTIVE"),
      tool("conv-1", 2, "DONE", { output: "a.txt\n" }),
      response("conv-1", 3, "ACTIVE", "Done: "),
      response("conv-1", 3, "DONE", "a.txt", {
        input_tokens: 2327,
        output_tokens: 129,
        thinking_tokens: 12,
        cache_read_tokens: 8943,
        total_tokens: 11411,
      }),
      result({ status: "SUCCESS", response: "I will list files.Done: a.txt" }),
    ]) {
      adapter.interpretLine(JSON.stringify(event), state);
    }
    expect(adapter.assess(state)).toMatchObject({
      succeeded: true,
      sessionId: "conv-1",
      result: "I will list files.Done: a.txt",
      contextTokens: 2327 + 8943 + 129,
    });
  });

  it("measures no occupancy from a subagent's response", () => {
    const state = adapter.createState(BASE);
    adapter.interpretLine(JSON.stringify(init("conv-1")), state);
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 };
    adapter.interpretLine(JSON.stringify(response("conv-1", 1, "DONE", "Main.", usage)), state);
    const subagentUsage = { input_tokens: 900, output_tokens: 90, cache_read_tokens: 0 };
    adapter.interpretLine(
      JSON.stringify(response("conv-sub", 1, "DONE", "Sub.", subagentUsage)),
      state,
    );
    expect(adapter.assess(state).contextTokens).toBe(110);
  });

  it.each<[string, object | undefined, unknown]>([
    [
      "an ERROR result carries its error",
      { status: "ERROR", response: "", error: "invalid model selection (gemini-x)" },
      "invalid model selection (gemini-x)",
    ],
    [
      "an early end fails a SUCCESS",
      { status: "SUCCESS", response: "Partial", finished_reason: "print_timeout" },
      expect.any(String),
    ],
    ["a blank response under SUCCESS", { status: "SUCCESS", response: "  " }, undefined],
    ["a stream without result", undefined, undefined],
  ])("does not succeed when %s", (_name, resultEvent, error) => {
    const state = adapter.createState(BASE);
    adapter.interpretLine(JSON.stringify(init("conv-1")), state);
    if (resultEvent !== undefined)
      adapter.interpretLine(JSON.stringify(result(resultEvent)), state);
    const assessment = adapter.assess(state);
    expect(assessment.succeeded).toBe(false);
    expect(assessment.error).toEqual(error);
  });
});

describe("Antigravity authentication", () => {
  it("takes the not-signed-in result as evidence", () => {
    const state = adapter.createState(BASE);
    adapter.interpretLine(
      JSON.stringify(
        result({
          conversation_id: "",
          status: "ERROR",
          response: "",
          error: "authentication failed or timed out",
        }),
      ),
      state,
    );
    expect(adapter.assess(state)).toMatchObject({ succeeded: false, authEvidence: true });
  });

  it.each([
    ["Error: authentication required. Run 'agy' to log in, then retry.", true],
    ["Error: invalid model selection (gemini-x)", false],
    ['warning: conversation "conv-0" not found', false],
  ])("recognizes stderr %j as an authentication failure: %s", (stderr, expected) => {
    expect(adapter.isAuthenticationError(stderr)).toBe(expected);
  });
});

describe("Antigravity resume", () => {
  it("records an identity failure when init opens another conversation", () => {
    const state = adapter.createState({ ...BASE, resume: "conv-old" });
    for (const event of [
      init("conv-new"),
      response("conv-new", 1, "DONE", "Done."),
      result({ conversation_id: "conv-new", status: "SUCCESS", response: "Done." }),
    ]) {
      adapter.interpretLine(JSON.stringify(event), state);
    }
    expect(state.identityFailure).toBeDefined();
    expect(adapter.assess(state)).toMatchObject({
      succeeded: false,
      sessionId: undefined,
      error: state.identityFailure,
    });
  });
});

function init(conversationId: string): object {
  return {
    event: "init",
    conversation_id: conversationId,
    init: { cwd: "/proj", tools: ["run_command"], permission_mode: "auto" },
  };
}

function response(
  conversationId: string,
  stepIndex: number,
  stepState: "ACTIVE" | "DONE",
  textDelta?: string,
  usage?: object,
): object {
  return {
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: stepState,
      step_type: "agent_response",
      ...(textDelta === undefined ? {} : { text_delta: textDelta }),
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function tool(
  conversationId: string,
  stepIndex: number,
  stepState: "ACTIVE" | "DONE",
  outcome: object = {},
): object {
  return {
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: stepState,
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, ...outcome },
    },
  };
}

function result(fields: object): object {
  return {
    event: "result",
    result: {
      conversation_id: "conv-1",
      num_turns: 1,
      usage: { input_tokens: 13314, output_tokens: 197, cache_read_tokens: 8943 },
      ...fields,
    },
  };
}
