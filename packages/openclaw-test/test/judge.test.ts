import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJudgeModelRef } from "../src/judge.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", "openrouter/anthropic/claude-haiku-4.5");
  vi.stubEnv("OPENROUTER_API_KEY", "offline-test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe("judge SDK compatibility", () => {
  it("sends the OpenRouter Haiku request and accounts for text and usage", async () => {
    respond({
      choices: [{ message: { content: "first" } }, { message: { content: " second" } }],
      usage: { prompt_tokens: 17, completion_tokens: 4 },
    });
    const judge = await freshJudge();
    const result = await judge.judgeLLMRaw("Evaluate this", { maxTokens: 256 });
    expect(result).toEqual({
      raw: "first second",
      usage: {
        model: "openrouter/anthropic/claude-haiku-4.5",
        inputTokens: 17,
        outputTokens: 4,
      },
    });
    const request = recordedRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer offline-test-key");
    expect(await request.json()).toEqual({
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 256,
      temperature: 0,
      messages: [{ role: "user", content: "Evaluate this" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains Anthropic content-block and token accounting", async () => {
    vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", "anthropic/claude-haiku-4-5");
    respond({
      content: [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "private" },
        { type: "text", text: " text" },
      ],
      usage: { input_tokens: 11, output_tokens: 3 },
    });
    const judge = await freshJudge();
    expect(await judge.judgeLLMRaw("Evaluate this")).toEqual({
      raw: "answer text",
      usage: { model: "anthropic/claude-haiku-4-5", inputTokens: 11, outputTokens: 3 },
    });
    const request = recordedRequest();
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(await request.json()).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: "Evaluate this" }],
    });
  });

  it.each(["openrouter/anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4-5"])(
    "rejects missing usage from %s without retrying",
    async (model) => {
      vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", model);
      respond({ choices: [{ message: { content: "answer" } }], content: [] });
      const judge = await freshJudge();
      await expect(judge.judgeLLMRaw("test")).rejects.toThrow("judge response missing usage");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['{"verdict":"maybe","reasoning":"no"}', /judge verdict invalid/],
    ['{"verdict":"pass","reasoning":42}', /judge reasoning not a string/],
    ["not JSON", /judge JSON parse failed/],
  ])("rejects malformed judge result %s", async (body, diagnostic) => {
    respond({
      choices: [{ message: { content: `<result-json>${body}</result-json>` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const judge = await freshJudge();
    await expect(judge.judgeLLM({ message: "test", rubric: "test" })).rejects.toThrow(diagnostic);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses tagged JSON through the public judge export", async () => {
    respond({
      choices: [{ message: { content: '<result-json>{"done":true}</result-json>' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    const judge = await freshJudge();
    const result = await judge.judgeLLMJson<{ done: boolean }>({
      message: "test",
      prompt: "Is it done?",
      returnType: "{ done: boolean }",
    });
    expect(result.parsed).toEqual({ done: true });
    expect(result.usage.inputTokens).toBe(2);
  });
});

function respond(body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );
}

async function freshJudge() {
  // Re-evaluate the public module so its cached SDK client uses this test's environment.
  return import("../src/judge.js");
}

function recordedRequest(): Request {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("Judge made no request");
  return new Request(call[0], call[1]);
}

describe("judge model references", () => {
  it("parses a direct Anthropic model", () => {
    expect(parseJudgeModelRef("anthropic/claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      bareModel: "claude-haiku-4-5",
    });
  });

  it("preserves the provider segment in an OpenRouter model ID", () => {
    expect(parseJudgeModelRef("openrouter/anthropic/claude-haiku-4.5")).toEqual({
      provider: "openrouter",
      bareModel: "anthropic/claude-haiku-4.5",
    });
  });

  it.each(["claude-haiku-4-5", "openai/gpt-5.6-terra", "openrouter/"])(
    "rejects unsupported or incomplete reference %s",
    (reference) => {
      expect(() => parseJudgeModelRef(reference)).toThrow(/OPENCLAW_TEST_JUDGE_MODEL/);
    },
  );
});
