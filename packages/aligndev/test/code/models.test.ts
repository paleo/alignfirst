import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type CatalogOutput,
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  createExecutableModelResolver,
  expandModelAlias,
  type ModelDiscoveryContext,
  ModelSignInRequiredError,
  resolveModels,
} from "../../src/code/models.js";

const CONTEXT = { cwd: "/project", env: { PATH: "/bin" } };
const PI_MODELS = `provider  model                    context  max-out  thinking  images
openai    gpt-6.1-sol              272K     128K     yes       yes
openai    gpt-6.2-sol              272K     128K     yes       yes
openai    gpt-6.2-sol-healthcare   1.1M     128K     yes       yes
openai    gpt-6.10-sol-healthcare  1.1M     128K     yes       yes
openai    gpt-5.6-terra            272K     128K     yes       yes
`;
const PI_MULTI_PROVIDER_MODELS = `provider    model                    context  max-out  thinking  images
openai      gpt-6.2-sol              272K     128K     yes       yes
openrouter  gpt-6.2-sol              272K     128K     yes       yes
`;
const AGY_MODELS = [
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-lite-high\tGemini 4 Neon Lite (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "",
].join("\n");

function completed(stdout: string): CatalogOutput {
  return { exitCode: 0, stdout, stderr: "" };
}

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
    const aliases = { fast: "sol", sol: "do-not-recurse" };
    expect(expandModelAlias("fast", aliases)).toBe("sol");
    expect(expandModelAlias("constructor", aliases)).toBe("constructor");
    expect(expandModelAlias(undefined, aliases)).toBeUndefined();
    const resolver = createExecutableModelResolver({
      codex: async () => completed(JSON.stringify({ models: [{ slug: "gpt-7-sol" }] })),
    });
    expect(await resolver("codex", expandModelAlias("fast", aliases), CONTEXT)).toBe("gpt-7-sol");
  });

  it("lets a profile alias pin a suffixed variant over the newest-model resolution", async () => {
    const pins = { sol: "openai/gpt-6.2-sol-healthcare" };
    const resolver = createExecutableModelResolver({ pi: async () => completed(PI_MODELS) });
    expect(await resolver("pi", "sol", CONTEXT)).toBe("openai/gpt-6.2-sol");
    expect(await resolver("pi", expandModelAlias("sol", pins), CONTEXT)).toBe(
      "openai/gpt-6.2-sol-healthcare",
    );
  });

  it("never reuses catalogs from a different effective execution context", async () => {
    const runner = vi.fn(async (context: ModelDiscoveryContext) =>
      completed(
        JSON.stringify({
          models: [{ slug: context.env.CODEX_HOME === "a" ? "gpt-5-sol" : "gpt-9-sol" }],
        }),
      ),
    );
    const resolver = createExecutableModelResolver({ codex: runner });
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
  it("orders major and minor versions numerically and narrows by alias", async () => {
    const slugs = [
      "gpt-5.9-astra",
      "gpt-6-astra",
      "gpt-5.9-terra",
      "gpt-5.10-terra",
      "gpt-6.1-luna",
      "gpt-99.1-sol",
    ];
    const resolve = createExecutableModelResolver({
      codex: async () => completed(JSON.stringify({ models: slugs.map((slug) => ({ slug })) })),
    });
    await expect(resolve("codex", "astra", CONTEXT)).resolves.toBe("gpt-6-astra");
    await expect(resolve("codex", "terra", CONTEXT)).resolves.toBe("gpt-5.10-terra");
    await expect(resolve("codex", "luna", CONTEXT)).resolves.toBe("gpt-6.1-luna");
  });

  it("skips discovery for omitted models, Claude, and explicit selectors", async () => {
    const runner = vi.fn(async () => completed(JSON.stringify({ models: [] })));
    const resolve = createExecutableModelResolver({ codex: runner, pi: runner, agy: runner });
    await expect(resolve("codex", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("claude", "opus", CONTEXT)).resolves.toBe("opus");
    await expect(resolve("agy", "gemini-4-neon", CONTEXT)).resolves.toBe("gemini-4-neon");
    await expect(resolve("pi", " provider/model:high ", CONTEXT)).resolves.toBe(
      " provider/model:high ",
    );
    await expect(resolve("pi", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("codex", "gpt-6.1-terra", CONTEXT)).resolves.toBe("gpt-6.1-terra");
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses one successfully parsed catalog without requiring other aliases", async () => {
    const runner = vi.fn(async () =>
      completed(JSON.stringify({ models: [{ slug: "gpt-6.1-terra" }, { slug: "gpt-5.7-luna" }] })),
    );
    const resolve = createExecutableModelResolver({ codex: runner });
    await expect(resolve("codex", "terra", CONTEXT)).resolves.toBe("gpt-6.1-terra");
    await expect(resolve("codex", "luna", CONTEXT)).resolves.toBe("gpt-5.7-luna");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["process failure", async () => Promise.reject(new Error("ENOENT"))],
    ["nonzero exit", async () => ({ exitCode: 1, stdout: "", stderr: "" })],
    ["malformed JSON", async () => completed("{")],
    ["unexpected shape", async () => completed(JSON.stringify({ items: [] }))],
    ["malformed model", async () => completed(JSON.stringify({ models: [{}] }))],
    [
      "missing alias",
      async () => completed(JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }] })),
    ],
  ])("rejects %s", async (_name, runner) => {
    const resolve = createExecutableModelResolver({ codex: runner });
    const attempt = resolve("codex", "terra", CONTEXT);
    await expect(attempt).rejects.toThrow(Error);
  });

  it.each([new Error("injected-catalog-secret"), "injected-catalog-secret"])(
    "omits arbitrary injected runner failures: %s",
    async (failure) => {
      const resolver = createExecutableModelResolver({
        codex: async () => {
          throw failure;
        },
      });
      const attempt = resolver("codex", "sol", CONTEXT);
      await expect(attempt).rejects.toThrow(Error);
      await expect(attempt).rejects.not.toThrow("injected-catalog-secret");
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
});

describe("Pi and Antigravity executable model resolution", () => {
  it("resolves a Pi alias to the newest unsuffixed model with its provider", async () => {
    const resolve = createExecutableModelResolver({ pi: async () => completed(PI_MODELS) });
    await expect(resolve("pi", "sol", CONTEXT)).resolves.toBe("openai/gpt-6.2-sol");
  });

  it("rejects a Pi alias whose newest model appears under several providers", async () => {
    const resolve = createExecutableModelResolver({
      pi: async () => completed(PI_MULTI_PROVIDER_MODELS),
    });
    await expect(resolve("pi", "sol", CONTEXT)).rejects.toThrow(Error);
  });

  it("resolves an Antigravity alias to the newest base name, ignoring variants", async () => {
    const resolve = createExecutableModelResolver({ agy: async () => completed(AGY_MODELS) });
    await expect(resolve("agy", "neon", CONTEXT)).resolves.toBe("gemini-4-neon");
    await expect(resolve("agy", "flash", CONTEXT)).resolves.toBe("gemini-3.8-flash");
    const variantsOnly = "gemini-4-neon-lite-high\tLite\ngemini-pro-orchestrator-neon\tO\n";
    const resolveVariants = createExecutableModelResolver({
      agy: async () => completed(variantsOnly),
    });
    await expect(resolveVariants("agy", "neon", CONTEXT)).rejects.toThrow(Error);
  });

  it.each([
    ["pi", "sol", PI_MODELS.split("\n").slice(1).join("\n")],
    ["agy", "neon", "gemini-4-neon-high Gemini 4 Neon (High)\n"],
  ] as const)("rejects malformed %s catalog output", async (agent, alias, output) => {
    const resolve = createExecutableModelResolver({ [agent]: async () => completed(output) });
    await expect(resolve(agent, alias, CONTEXT)).rejects.toThrow(Error);
  });

  it("reads a Pi model id containing a space as one id", async () => {
    const catalog = `provider  model                   context  max-out  thinking  images
openai    gpt-6.2-sol             272K     128K     yes       yes
openai    gpt-7-sol experimental  272K     128K     yes       yes
`;
    const resolve = createExecutableModelResolver({ pi: async () => completed(catalog) });
    await expect(resolve("pi", "sol", CONTEXT)).resolves.toBe("openai/gpt-6.2-sol");
  });

  it("parses the Pi table after startup output", async () => {
    const catalog = `[my-extension] provider registered\n${PI_MODELS}`;
    const resolve = createExecutableModelResolver({ pi: async () => completed(catalog) });
    await expect(resolve("pi", "sol", CONTEXT)).resolves.toBe("openai/gpt-6.2-sol");
  });

  it("ends the Pi table at an extension log after the rows", async () => {
    const resolve = createExecutableModelResolver({
      pi: async () => completed(`${PI_MODELS}Catalog done\n`),
    });
    await expect(resolve("pi", "sol", CONTEXT)).resolves.toBe("openai/gpt-6.2-sol");
  });

  it.each([
    ["an extension message", 0, "No models available. The local cache is missing.\n"],
    ["a failed command", 7, "No models available. Use /login to log into a provider.\n"],
  ])("keeps %s from Pi out of the sign-in handoff", async (_name, exitCode, stdout) => {
    const resolve = createExecutableModelResolver({
      pi: async () => ({ exitCode, stdout, stderr: "" }),
    });
    const attempt = resolve("pi", "sol", CONTEXT);
    await expect(attempt).rejects.toThrow(Error);
    await expect(attempt).rejects.not.toBeInstanceOf(ModelSignInRequiredError);
  });

  it.each([
    [
      "pi",
      "sol",
      completed("No models available. Use /login to log into a provider via OAuth or API key.\n"),
    ],
    [
      "agy",
      "neon",
      {
        exitCode: 1,
        stdout: "",
        stderr: "Fetching available models...\nError: Please sign in to view available models.\n",
      },
    ],
  ] as const)("reports a %s catalog that requires sign-in", async (agent, alias, output) => {
    const resolve = createExecutableModelResolver({ [agent]: async () => output });
    await expect(resolve(agent, alias, CONTEXT)).rejects.toThrow(ModelSignInRequiredError);
  });
});
