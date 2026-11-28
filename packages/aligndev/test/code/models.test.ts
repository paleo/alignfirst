import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  createExecutableModelResolver,
  expandModelAlias,
  type ModelDiscoveryContext,
  parseBundledModelSlugs,
  resolveModels,
  selectNewestCodexModel,
} from "../../src/code/models.js";

const CONTEXT = { cwd: "/project", env: { PATH: "/bin" } };

describe("resolveModels", () => {
  it("uses agent-specific defaults", () => {
    expect(resolveModels("claude", undefined)).toEqual(CLAUDE_DEFAULT_MODELS);
    expect(resolveModels("codex", [])).toEqual(CODEX_DEFAULT_MODELS);
    expect(resolveModels("pi", undefined)).toBeUndefined();
    expect(resolveModels("pi", [])).toBeUndefined();
    expect(resolveModels("pi", ["provider/model:high"])).toEqual(["provider/model:high"]);
    expect(resolveModels("codex", ["terra", "luna"])).toEqual(["terra", "luna"]);
  });
});

describe("profile model aliases", () => {
  it("adds aliases to native defaults only without a nonempty override", () => {
    expect(resolveModels("claude", [], { fast: "model-a" })).toEqual([
      ...CLAUDE_DEFAULT_MODELS,
      "fast",
    ]);
    expect(resolveModels("codex", undefined, { fast: "model-a" })).toEqual([
      ...CODEX_DEFAULT_MODELS,
      "fast",
    ]);
    expect(resolveModels("codex", ["fast"], { other: "model-a" })).toEqual(["fast"]);
    expect(resolveModels("pi", undefined, { fast: "provider/model-a" })).toBeUndefined();
  });

  it("expands exactly once and uses own alias properties", async () => {
    const aliases = { fast: "sol", sol: "do-not-recurse", pinned: "openai/model:high" };
    expect(expandModelAlias("fast", aliases)).toBe("sol");
    expect(expandModelAlias("constructor", aliases)).toBe("constructor");
    expect(expandModelAlias(undefined, aliases)).toBeUndefined();
    const resolver = createExecutableModelResolver(async () =>
      JSON.stringify({ models: [{ slug: "gpt-3-sol" }] }),
    );
    expect(await resolver("codex", expandModelAlias("fast", aliases), CONTEXT)).toBe("gpt-3-sol");
    expect(await resolver("pi", expandModelAlias("pinned", aliases), CONTEXT)).toBe(
      "openai/model:high",
    );
  });

  it("never reuses catalogs from a different effective execution context", async () => {
    const runner = vi.fn(async (context: ModelDiscoveryContext) =>
      JSON.stringify({
        models: [{ slug: context.env.CODEX_HOME === "a" ? "gpt-1-sol" : "gpt-9-sol" }],
      }),
    );
    const resolver = createExecutableModelResolver(runner);
    expect(
      await resolver("codex", "sol", { cwd: "/a", env: { CODEX_HOME: "a", PATH: "/a/bin" } }),
    ).toBe("gpt-1-sol");
    expect(
      await resolver("codex", "sol", { cwd: "/b", env: { CODEX_HOME: "b", PATH: "/b/bin" } }),
    ).toBe("gpt-9-sol");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("Codex executable model resolution", () => {
  it("orders major and minor versions numerically and narrows by alias", () => {
    const slugs = [
      "gpt-1.9-astra",
      "gpt-2-astra",
      "gpt-1.9-terra",
      "gpt-1.10-terra",
      "gpt-2.1-luna",
      "gpt-99.1-sol",
    ];
    expect(selectNewestCodexModel(slugs, "astra")).toBe("gpt-2-astra");
    expect(selectNewestCodexModel(slugs, "terra")).toBe("gpt-1.10-terra");
    expect(selectNewestCodexModel(slugs, "luna")).toBe("gpt-2.1-luna");
  });

  it("skips discovery for omitted models, Claude, and explicit Codex slugs", async () => {
    const runner = vi.fn(async () => JSON.stringify({ models: [] }));
    const resolve = createExecutableModelResolver(runner);
    await expect(resolve("codex", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("claude", "opus", CONTEXT)).resolves.toBe("opus");
    await expect(resolve("pi", "terra", CONTEXT)).resolves.toBe("terra");
    await expect(resolve("pi", " provider/model:high ", CONTEXT)).resolves.toBe(
      " provider/model:high ",
    );
    await expect(resolve("pi", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("codex", "gpt-2.1-terra", CONTEXT)).resolves.toBe("gpt-2.1-terra");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses one successfully parsed catalog without requiring other aliases", async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({ models: [{ slug: "gpt-2.1-terra" }, { slug: "gpt-1.7-luna" }] }),
    );
    const resolve = createExecutableModelResolver(runner);
    await expect(resolve("codex", "terra", CONTEXT)).resolves.toBe("gpt-2.1-terra");
    await expect(resolve("codex", "luna", CONTEXT)).resolves.toBe("gpt-1.7-luna");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["process failure", async () => Promise.reject(new Error("ENOENT"))],
    ["malformed JSON", async () => "{"],
    ["missing alias", async () => JSON.stringify({ models: [{ slug: "gpt-1.6-luna" }] })],
  ])("rejects %s", async (_name, runner) => {
    const resolve = createExecutableModelResolver(runner);
    const attempt = resolve("codex", "terra", CONTEXT);
    await expect(attempt).rejects.toThrow(Error);
  });

  it("omits arbitrary injected runner failures", async () => {
    const resolver = createExecutableModelResolver(async () => {
      throw new Error("injected-catalog-secret");
    });
    const attempt = resolver("codex", "sol", CONTEXT);
    await expect(attempt).rejects.toThrow(Error);
    await expect(attempt).rejects.not.toThrow("injected-catalog-secret");
  });

  it("sanitizes native catalog output and failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "aligndev-catalog-"));
    try {
      writeFileSync(
        join(root, "codex"),
        "#!/bin/sh\nprintf native-catalog-secret\nprintf native-catalog-secret >&2\nexit 1\n",
        { mode: 0o755 },
      );
      const resolver = createExecutableModelResolver();
      const context = { cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: root } };
      const attempt = resolver("codex", "sol", context);
      await expect(attempt).rejects.toThrow(Error);
      await expect(attempt).rejects.not.toThrow("native-catalog-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes native spawn failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "aligndev-missing-catalog-"));
    try {
      await expect(
        createExecutableModelResolver()("codex", "sol", {
          cwd: root,
          env: { HOME: root, CODEX_HOME: root, PATH: root },
        }),
      ).rejects.toThrow(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates every catalog model shape", () => {
    expect(() => parseBundledModelSlugs(JSON.stringify({ models: [{}] }))).toThrow(Error);
  });
});
