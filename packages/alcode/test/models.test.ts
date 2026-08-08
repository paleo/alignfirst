import { describe, expect, it } from "vitest";

import { DEFAULT_MODELS, resolveModels } from "../src/models.js";

describe("resolveModels", () => {
  it("falls back to the default list when the env var is unset or blank", () => {
    expect(resolveModels({})).toBe(DEFAULT_MODELS);
    expect(resolveModels({ ALIGNFIRST_CODE_MODELS: "" })).toBe(DEFAULT_MODELS);
    expect(resolveModels({ ALIGNFIRST_CODE_MODELS: " , " })).toBe(DEFAULT_MODELS);
  });

  it("parses a comma-list, trimming whitespace and empty entries", () => {
    expect(resolveModels({ ALIGNFIRST_CODE_MODELS: "sonnet, haiku ,," })).toEqual([
      "sonnet",
      "haiku",
    ]);
  });
});
