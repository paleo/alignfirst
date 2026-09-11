import { describe, expect, it } from "vitest";
import { parseJudgeModelRef } from "../src/judge.js";

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
