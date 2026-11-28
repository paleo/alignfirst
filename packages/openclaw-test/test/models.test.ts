import { describe, expect, it } from "vitest";
import { resolveSelectedModels } from "../src/models.js";

const MODELS = "anthropic/claude-sonnet-5,custom-openrouter/qwen/qwen3.8-flash";

function resolve(selection: string | undefined, defaultEnv?: string) {
  return resolveSelectedModels({ selection, modelsEnv: MODELS, defaultEnv });
}

describe("resolveSelectedModels", () => {
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

  it.each<{ name: string; selection: string | undefined; modelsEnv?: string }>([
    { name: "an unknown id", selection: "nope" },
    { name: "an unknown id in a list", selection: "claude-sonnet-5,nope" },
    { name: "an omitted selection without default", selection: undefined },
    { name: "an empty id list", selection: " , " },
    { name: "an empty catalog", selection: "all", modelsEnv: "" },
  ])("throws on $name", ({ selection, modelsEnv = MODELS }) => {
    expect(() => resolveSelectedModels({ selection, modelsEnv, defaultEnv: undefined })).toThrow();
  });
});
