import { describe, expect, it } from "vitest";
import { judgeCostUsd } from "../src/cost.js";

describe("Haiku 5.5 judge pricing", () => {
  it.each(["anthropic/claude-haiku-5-5", "openrouter/anthropic/claude-haiku-5.5"])(
    "prices the entire request by prompt length for %s",
    (model) => {
      expect(judgeCostUsd({ model, inputTokens: 100_000, outputTokens: 1_000 })).toBeCloseTo(
        0.0105,
        10,
      );
      expect(judgeCostUsd({ model, inputTokens: 100_001, outputTokens: 1_000 })).toBeCloseTo(
        0.0525005,
        10,
      );
    },
  );
});
