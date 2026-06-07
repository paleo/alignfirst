import { describe, expect, it } from "vitest";
import { resolveSelectedModels } from "../src/models.js";

const MODELS = "anthropic/claude-sonnet-4-6,custom-openrouter/qwen/qwen3.6-plus";

function resolve(selection: string | undefined, defaultEnv?: string) {
  return resolveSelectedModels({ selection, modelsEnv: MODELS, defaultEnv });
}

describe("resolveSelectedModels", () => {
  it("resolves a single bare id to its full ref", () => {
    expect(resolve("qwen3.6-plus")).toEqual([
      { id: "qwen3.6-plus", ref: "custom-openrouter/qwen/qwen3.6-plus" },
    ]);
  });

  it("resolves a comma list of bare ids, order preserved", () => {
    expect(resolve("qwen3.6-plus,claude-sonnet-4-6")).toEqual([
      { id: "qwen3.6-plus", ref: "custom-openrouter/qwen/qwen3.6-plus" },
      { id: "claude-sonnet-4-6", ref: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("dedupes repeated ids in a list", () => {
    expect(resolve("qwen3.6-plus,qwen3.6-plus")).toEqual([
      { id: "qwen3.6-plus", ref: "custom-openrouter/qwen/qwen3.6-plus" },
    ]);
  });

  it("expands 'all' to the whole catalog, sorted by bare id regardless of env order", () => {
    expect(
      resolveSelectedModels({
        selection: "all",
        modelsEnv: "custom-openrouter/qwen/qwen3.6-plus,anthropic/claude-sonnet-4-6",
        defaultEnv: undefined,
      }),
    ).toEqual([
      { id: "claude-sonnet-4-6", ref: "anthropic/claude-sonnet-4-6" },
      { id: "qwen3.6-plus", ref: "custom-openrouter/qwen/qwen3.6-plus" },
    ]);
  });

  it("falls back to the default bare id when selection is omitted", () => {
    expect(resolve(undefined, "claude-sonnet-4-6")).toEqual([
      { id: "claude-sonnet-4-6", ref: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("throws on an unknown id (single or in a list)", () => {
    expect(() => resolve("nope")).toThrow(/not found/);
    expect(() => resolve("claude-sonnet-4-6,nope")).toThrow(/not found/);
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
