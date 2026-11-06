import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureEnvironment } from "./environment.js";

const fetchMock = vi.fn<typeof fetch>();
const responses: unknown[] = [];
const unexpectedRequests: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(strictFetch);
  const clean = fixtureEnvironment();
  for (const key of Object.keys(process.env)) {
    if (!(key in clean)) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", "openrouter/anthropic/claude-haiku-5.5");
  vi.stubEnv("OPENROUTER_API_KEY", "offline-test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
  const failures = unexpectedRequests.splice(0);
  const remaining = responses.splice(0);
  expect(failures, "Unexpected judge requests (not retried by the fake)").toEqual([]);
  expect(remaining, "Unused judge responses").toEqual([]);
});

describe("judge SDK compatibility", () => {
  it("uses default Haiku with required verdict reasoning and accounts for text and usage", async () => {
    vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", undefined);
    respond({
      choices: [
        { message: { content: '<result-json>{"verdict":"pass",' } },
        { message: { content: '"reasoning":"Meets the rubric"}</result-json>' } },
      ],
      usage: { prompt_tokens: 17, completion_tokens: 4 },
    });
    const judge = await freshJudge();
    const result = await judge.judgeLLM({
      message: "Evaluate this",
      rubric: "Meets the requirement",
      maxTokens: 256,
    });
    expect(result).toEqual({
      verdict: "pass",
      reasoning: "Meets the rubric",
      raw: '<result-json>{"verdict":"pass","reasoning":"Meets the rubric"}</result-json>',
      usage: {
        model: "openrouter/anthropic/claude-haiku-5.5",
        inputTokens: 17,
        outputTokens: 4,
      },
    });
    const request = recordedRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer offline-test-key");
    expect(await request.json()).toEqual({
      model: "anthropic/claude-haiku-5.5",
      max_tokens: 256,
      reasoning_effort: "low",
      messages: [{ role: "user", content: expect.stringContaining("Evaluate this") }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains Anthropic content-block and token accounting", async () => {
    vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", "anthropic/claude-haiku-5-5");
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
      usage: { model: "anthropic/claude-haiku-5-5", inputTokens: 11, outputTokens: 3 },
    });
    const request = recordedRequest();
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("authorization")).toBe("Bearer offline-test-key");
    expect(request.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(await request.json()).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 4096,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Evaluate this" }],
    });
  });

  it.each(["openrouter/other/model", "anthropic/other-model"])(
    "preserves explicit caps without forcing effort on override %s",
    async (model) => {
      vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", model);
      respond({
        choices: [{ message: { content: "answer" } }],
        content: [{ type: "text", text: "answer" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, input_tokens: 1, output_tokens: 2 },
      });
      const judge = await freshJudge();
      await judge.judgeLLMRaw("test", { maxTokens: 128 });
      expect(await recordedRequest().json()).toEqual({
        model: model.slice(model.indexOf("/") + 1),
        max_tokens: 128,
        ...(model.startsWith("openrouter/") ? { temperature: 0 } : {}),
        messages: [{ role: "user", content: "test" }],
      });
    },
  );

  it.each(["openrouter/anthropic/claude-haiku-5.5", "anthropic/claude-haiku-5-5"])(
    "rejects missing usage from %s without retrying",
    async (model) => {
      vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", model);
      respond({ choices: [{ message: { content: "answer" } }], content: [] });
      const judge = await freshJudge();
      await expect(judge.judgeLLMRaw("test")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    '{"verdict":"maybe","reasoning":"no"}',
    '{"verdict":"pass","reasoning":42}',
    "not JSON",
  ])("rejects malformed judge result %s", async (body) => {
    respond({
      choices: [{ message: { content: `<result-json>${body}</result-json>` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const judge = await freshJudge();
    await expect(judge.judgeLLM({ message: "test", rubric: "test" })).rejects.toThrow();
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
  responses.push(body);
}

async function strictFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    const request = new Request(input, init);
    const anthropic = process.env.OPENCLAW_TEST_JUDGE_MODEL?.startsWith("anthropic/") === true;
    expect(request.url).toBe(
      anthropic
        ? "https://api.anthropic.com/v1/messages"
        : "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toContain("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer offline-test-key");
    const body = await request.json();
    expect(typeof body.model).toBe("string");
    expect(Number.isInteger(body.max_tokens) && body.max_tokens > 0).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: expect.any(String) }]);
    const allowed = anthropic
      ? ["model", "max_tokens", "messages", "output_config"]
      : ["model", "max_tokens", "messages", "reasoning_effort", "temperature"];
    expect(Object.keys(body).filter((key) => !allowed.includes(key))).toEqual([]);
    if (responses.length === 0) throw new Error("Judge response queue exhausted");
    return new Response(JSON.stringify(responses.shift()), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    unexpectedRequests.push(error instanceof Error ? error.message : String(error));
    // A non-retryable SDK response exposes a bad fake request immediately; teardown also fails.
    return new Response(
      JSON.stringify({ error: { message: "Unexpected offline judge request" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }
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
  it.each(["claude-haiku-5-5", "openai/gpt-6.1-terra", "openrouter/"])(
    "rejects unsupported or incomplete reference %s before any request",
    async (reference) => {
      vi.stubEnv("OPENCLAW_TEST_JUDGE_MODEL", reference);
      const judge = await freshJudge();
      await expect(judge.judgeLLMRaw("test")).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
