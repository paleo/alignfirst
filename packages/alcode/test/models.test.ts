import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  createExecutableModelResolver,
  parseBundledModelSlugs,
  resolveModels,
  selectNewestCodexModel,
} from "../src/models.js";

const CONTEXT = { cwd: "/project", env: { PATH: "/bin" } };

describe("resolveModels", () => {
  it("uses agent-specific defaults", () => {
    expect(resolveModels("claude", {})).toBe(CLAUDE_DEFAULT_MODELS);
    expect(resolveModels("codex", {})).toBe(CODEX_DEFAULT_MODELS);
  });

  it("parses a trimmed comma-list replacement", () => {
    expect(resolveModels("codex", { ALIGNFIRST_CODE_MODELS: "terra, luna ,," })).toEqual([
      "terra",
      "luna",
    ]);
  });
});

describe("Codex executable model resolution", () => {
  it("orders major and minor versions numerically and narrows by alias", () => {
    const slugs = ["gpt-5.9-terra", "gpt-5.10-terra", "gpt-6.1-luna", "gpt-99.1-sol"];
    expect(selectNewestCodexModel(slugs, "terra")).toBe("gpt-5.10-terra");
    expect(selectNewestCodexModel(slugs, "luna")).toBe("gpt-6.1-luna");
  });

  it("skips discovery for omitted models, Claude, and explicit Codex slugs", async () => {
    const runner = vi.fn(async () => JSON.stringify({ models: [] }));
    const resolve = createExecutableModelResolver(runner);
    await expect(resolve("codex", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("claude", "opus", CONTEXT)).resolves.toBe("opus");
    await expect(resolve("codex", "gpt-5.6-terra", CONTEXT)).resolves.toBe("gpt-5.6-terra");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses one successfully parsed catalog without requiring other aliases", async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }, { slug: "gpt-5.7-luna" }] }),
    );
    const resolve = createExecutableModelResolver(runner);
    await expect(resolve("codex", "terra", CONTEXT)).resolves.toBe("gpt-5.6-terra");
    await expect(resolve("codex", "luna", CONTEXT)).resolves.toBe("gpt-5.7-luna");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["process failure", async () => Promise.reject(new Error("ENOENT"))],
    ["malformed JSON", async () => "{"],
    ["unexpected shape", async () => JSON.stringify({ items: [] })],
    ["missing alias", async () => JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }] })],
  ])("reports an actionable %s", async (_name, runner) => {
    const resolve = createExecutableModelResolver(runner);
    await expect(resolve("codex", "terra", CONTEXT)).rejects.toThrow(/Update the Codex CLI/);
    await expect(resolve("codex", "terra", CONTEXT)).rejects.toThrow(/ALIGNFIRST_CODE_MODELS/);
  });

  it("validates every catalog model shape", () => {
    expect(() => parseBundledModelSlugs(JSON.stringify({ models: [{}] }))).toThrow(
      /unexpected model catalog shape/,
    );
  });
});
