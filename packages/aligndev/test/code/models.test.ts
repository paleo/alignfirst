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
  });

  it("replaces the defaults with the configured list", () => {
    expect(resolveModels("codex", ["terra", "luna"])).toEqual(["terra", "luna"]);
  });
});

describe("profile model aliases", () => {
  it("adds aliases to native defaults only without a nonempty override", () => {
    expect(resolveModels("claude", [], { fast: "sonnet" })).toEqual([
      ...CLAUDE_DEFAULT_MODELS,
      "fast",
    ]);
    expect(resolveModels("codex", undefined, { fast: "sol" })).toEqual([
      ...CODEX_DEFAULT_MODELS,
      "fast",
    ]);
    expect(resolveModels("codex", ["fast"], { other: "sol" })).toEqual(["fast"]);
    expect(resolveModels("pi", undefined, { fast: "openai/sol" })).toBeUndefined();
  });

  it("expands exactly once and uses own alias properties", async () => {
    const aliases = { fast: "sol", sol: "do-not-recurse", pinned: "openai/model:high" };
    expect(expandModelAlias("fast", aliases)).toBe("sol");
    expect(expandModelAlias("constructor", aliases)).toBe("constructor");
    expect(expandModelAlias(undefined, aliases)).toBeUndefined();
    const resolver = createExecutableModelResolver(async () =>
      JSON.stringify({ models: [{ slug: "gpt-7-sol" }] }),
    );
    expect(await resolver("codex", expandModelAlias("fast", aliases), CONTEXT)).toBe("gpt-7-sol");
    expect(await resolver("pi", expandModelAlias("pinned", aliases), CONTEXT)).toBe(
      "openai/model:high",
    );
  });

  it("never reuses catalogs from a different effective execution context", async () => {
    const runner = vi.fn(async (context: ModelDiscoveryContext) =>
      JSON.stringify({
        models: [{ slug: context.env.CODEX_HOME === "a" ? "gpt-5-sol" : "gpt-9-sol" }],
      }),
    );
    const resolver = createExecutableModelResolver(runner);
    expect(
      await resolver("codex", "sol", { cwd: "/a", env: { CODEX_HOME: "a", PATH: "/a/bin" } }),
    ).toBe("gpt-5-sol");
    expect(
      await resolver("codex", "sol", { cwd: "/b", env: { CODEX_HOME: "b", PATH: "/b/bin" } }),
    ).toBe("gpt-9-sol");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("Codex executable model resolution", () => {
  it("orders major and minor versions numerically and narrows by alias", () => {
    const slugs = [
      "gpt-5.9-astra",
      "gpt-6-astra",
      "gpt-5.9-terra",
      "gpt-5.10-terra",
      "gpt-6.1-luna",
      "gpt-99.1-sol",
    ];
    expect(selectNewestCodexModel(slugs, "astra")).toBe("gpt-6-astra");
    expect(selectNewestCodexModel(slugs, "terra")).toBe("gpt-5.10-terra");
    expect(selectNewestCodexModel(slugs, "luna")).toBe("gpt-6.1-luna");
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
    await expect(resolve("codex", "terra", CONTEXT)).rejects.toThrow(
      /`code.profiles.<name>.models` in the aligndev settings/,
    );
  });

  it.each([new Error("injected-catalog-secret"), "injected-catalog-secret"])(
    "omits arbitrary injected runner failures: %s",
    async (failure) => {
      const resolver = createExecutableModelResolver(async () => {
        throw failure;
      });
      await expect(resolver("codex", "sol", CONTEXT)).rejects.toThrow(/Update the Codex CLI/);
      await expect(resolver("codex", "sol", CONTEXT)).rejects.not.toThrow(
        "injected-catalog-secret",
      );
    },
  );

  it.each([0, 1])("sanitizes native catalog output and failure (exit %i)", async (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "aligndev-catalog-"));
    try {
      writeFileSync(
        join(root, "codex"),
        `#!${process.execPath}
process.stdout.write("native-catalog-secret");
process.stderr.write("native-catalog-secret");
process.exit(${exitCode});
`,
        { mode: 0o755 },
      );
      const resolver = createExecutableModelResolver();
      const context = { cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: root } };
      await expect(resolver("codex", "sol", context)).rejects.toThrow(/Update the Codex CLI/);
      await expect(resolver("codex", "sol", context)).rejects.not.toThrow("native-catalog-secret");
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
      ).rejects.toThrow(/Unable to resolve Codex model alias/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates every catalog model shape", () => {
    expect(() => parseBundledModelSlugs(JSON.stringify({ models: [{}] }))).toThrow(
      /unexpected model catalog shape/,
    );
  });
});
