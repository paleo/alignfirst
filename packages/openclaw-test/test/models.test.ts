import { describe, expect, it } from "vitest";
import { resolveSelectedModels } from "../src/models.js";

const MODELS = "anthropic/claude-sonnet-5,custom-openrouter/qwen/qwen3.8-flash";

function resolve(selection: string | undefined, defaultEnv?: string) {
  return resolveSelectedModels({ selection, modelsEnv: MODELS, defaultEnv });
}

describe("resolveSelectedModels", () => {
  it("resolves a single bare id to its full ref", () => {
    expect(resolve("qwen3.8-flash")).toEqual([
      { id: "qwen3.8-flash", ref: "custom-openrouter/qwen/qwen3.8-flash" },
    ]);
  });

  it("resolves a comma list of bare ids, order preserved", () => {
    expect(resolve("qwen3.8-flash,claude-sonnet-5")).toEqual([
      { id: "qwen3.8-flash", ref: "custom-openrouter/qwen/qwen3.8-flash" },
      { id: "claude-sonnet-5", ref: "anthropic/claude-sonnet-5" },
    ]);
  });

  it("dedupes repeated ids in a list", () => {
    expect(resolve("qwen3.8-flash,qwen3.8-flash")).toEqual([
      { id: "qwen3.8-flash", ref: "custom-openrouter/qwen/qwen3.8-flash" },
    ]);
  });

  it("expands 'all' to the whole catalog, sorted by bare id regardless of env order", () => {
    expect(
      resolveSelectedModels({
        selection: "all",
        modelsEnv: "custom-openrouter/qwen/qwen3.8-flash,anthropic/claude-sonnet-5",
        defaultEnv: undefined,
      }),
    ).toEqual([
      { id: "claude-sonnet-5", ref: "anthropic/claude-sonnet-5" },
      { id: "qwen3.8-flash", ref: "custom-openrouter/qwen/qwen3.8-flash" },
    ]);
  });

  it("falls back to the default bare id when selection is omitted", () => {
    expect(resolve(undefined, "claude-sonnet-5")).toEqual([
      { id: "claude-sonnet-5", ref: "anthropic/claude-sonnet-5" },
    ]);
  });

  it("throws on an unknown id (single or in a list)", () => {
    expect(() => resolve("nope")).toThrow(/not found/);
    expect(() => resolve("claude-sonnet-5,nope")).toThrow(/not found/);
  });

  it("throws when selection is omitted and no default is set", () => {
    expect(() => resolve(undefined)).toThrow(/OPENCLAW_DEFAULT_TEST_MODEL is unset/);
  });

  it("throws on an empty id list", () => {
    expect(() => resolve(" , ")).toThrow(/non-empty id list/);
  });

  it("throws when the catalog env is empty", () => {
    expect(() =>
      resolveSelectedModels({ selection: "all", modelsEnv: "", defaultEnv: undefined }),
    ).toThrow(/OPENCLAW_TEST_MODELS is empty/);
  });
});
