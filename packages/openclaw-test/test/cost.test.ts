import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeCostUsd } from "../src/cost.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("judgeCostUsd", () => {
  it.each<{ input: string | undefined; output: string | undefined; expected: number | undefined }>([
    { input: "0.5", output: "2", expected: 1.5 },
    { input: undefined, output: "2", expected: undefined },
    { input: "0.5", output: "", expected: undefined },
  ])("prices with input $input and output $output USD/MTok", ({ input, output, expected }) => {
    vi.stubEnv("OPENCLAW_TEST_JUDGE_INPUT_USD_PER_MTOK", input);
    vi.stubEnv("OPENCLAW_TEST_JUDGE_OUTPUT_USD_PER_MTOK", output);
    const usage = {
      model: "openrouter/vendor/beta",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    };
    expect(judgeCostUsd(usage)).toBe(expected);
  });
});
