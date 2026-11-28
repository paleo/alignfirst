import { describe, expect, it } from "vitest";
import { resolveSelectedModels } from "../src/models.js";

const MODELS = "anthropic/model-a,custom-openrouter/vendor/model-b";

function resolve(selection: string | undefined, defaultEnv?: string) {
  return resolveSelectedModels({ selection, modelsEnv: MODELS, defaultEnv });
}

describe("resolveSelectedModels", () => {
  it("resolves a comma list of bare ids, order preserved", () => {
    expect(resolve("model-b,model-a")).toEqual([
      { id: "model-b", ref: "custom-openrouter/vendor/model-b" },
      { id: "model-a", ref: "anthropic/model-a" },
    ]);
  });

  it("dedupes repeated ids in a list", () => {
    expect(resolve("model-b,model-b")).toEqual([
      { id: "model-b", ref: "custom-openrouter/vendor/model-b" },
    ]);
  });

  it("expands 'all' to the whole catalog, sorted by bare id regardless of env order", () => {
    expect(
      resolveSelectedModels({
        selection: "all",
        modelsEnv: "custom-openrouter/vendor/model-b,anthropic/model-a",
        defaultEnv: undefined,
      }),
    ).toEqual([
      { id: "model-a", ref: "anthropic/model-a" },
      { id: "model-b", ref: "custom-openrouter/vendor/model-b" },
    ]);
  });

  it("falls back to the default bare id when selection is omitted", () => {
    expect(resolve(undefined, "model-a")).toEqual([{ id: "model-a", ref: "anthropic/model-a" }]);
  });

  it.each<{ name: string; selection: string | undefined; modelsEnv?: string }>([
    { name: "an unknown id", selection: "nope" },
    { name: "an unknown id in a list", selection: "model-a,nope" },
    { name: "an omitted selection without default", selection: undefined },
    { name: "an empty id list", selection: " , " },
    { name: "an empty catalog", selection: "all", modelsEnv: "" },
  ])("throws on $name", ({ selection, modelsEnv = MODELS }) => {
    expect(() => resolveSelectedModels({ selection, modelsEnv, defaultEnv: undefined })).toThrow();
  });
});
