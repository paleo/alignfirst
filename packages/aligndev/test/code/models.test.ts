import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type CatalogOutput,
  createExecutableModelResolver,
  expandBuiltInAlias,
  expandModelAlias,
  type ModelDiscoveryContext,
  ModelSignInRequiredError,
  PiStartupDialogError,
  resolveModels,
} from "../../src/code/models.js";

const CONTEXT = { cwd: "/project", env: { PATH: "/bin" } };
const CODEX_PATTERN = "gpt-{latest}-sol";
const PI_PATTERN = "openai/gpt-{latest}-sol";
const AGY_PATTERN = "gemini-{latest}-neon";
const PI_MODELS = piResponse([
  ["openai", "gpt-6-sol"],
  ["openai", "gpt-6.1-sol"],
  ["openai", "gpt-6.2-sol"],
  ["openai", "gpt-6.2-sol-healthcare"],
  ["openai", "gpt-6.10-sol-healthcare"],
  ["anthropic", "claude-opus-5-5"],
  ["anthropic", "claude-opus-4-5-20251101"],
  ["anthropic", "claude-opus-6-20270101"],
  ["zai", "glm-5.4"],
  ["zai", "glm-6.1-flash"],
]);
const AGY_MODELS = [
  "gemini-4-carbon-max\tGemini 4 Carbon (Max)",
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-low\tGemini 4 Neon (Low)",
  "gemini-5-neon-lite-high\tGemini 5 Neon Lite (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "",
].join("\n");

// Answers the first `get_available_models` request with one model.
const ANSWER_CATALOG_REQUEST = `let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const { id, type } = JSON.parse(input.slice(0, input.indexOf("\\n")));
  if (type !== "get_available_models") process.exit(3);
  const models = [{ provider: "openai", id: "gpt-6.2-sol" }];
  process.stdout.write(JSON.stringify({ id, type: "response", success: true, data: { models } }) + "\\n");
});`;

function completed(stdout: string): CatalogOutput {
  return { exitCode: 0, stdout, stderr: "" };
}

function codexCatalog(slugs: readonly string[]): CatalogOutput {
  return completed(JSON.stringify({ models: slugs.map((slug) => ({ slug })) }));
}

// Pi's RPC stdout: an unrelated protocol record, then the response to the catalog request.
function piResponse(models: readonly (readonly [string, string])[]): string {
  const response = {
    id: "aligndev-models",
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models: models.map(([provider, id]) => ({ provider, id, name: id })) },
  };
  return `${JSON.stringify({ type: "extension_ui_request", id: "x" })}\n${JSON.stringify(response)}\n`;
}

describe("resolveModels", () => {
  it("accepts the built-in aliases of Claude and Codex plus the alias names", () => {
    expect(resolveModels({ harness: "claude", modelAliases: { fast: "sonnet" } })).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "fast",
    ]);
    expect(resolveModels({ harness: "codex", models: [], modelAliases: { sol: "x" } })).toEqual([
      "astra",
      "sol",
      "terra",
      "luna",
    ]);
  });

  it("accepts only the names a Pi profile declares", () => {
    expect(resolveModels({ harness: "pi" })).toEqual([]);
    expect(
      resolveModels({
        harness: "pi",
        modelFamilies: { claude: "anthropic", gpt: "openai" },
        modelAliases: { glm: "zai/glm-{latest}" },
      }),
    ).toEqual(["fable", "opus", "sonnet", "haiku", "astra", "sol", "terra", "luna", "glm"]);
  });

  it("replaces the accepted names with a nonempty models list", () => {
    expect(resolveModels({ harness: "codex", models: ["terra", "luna"] })).toEqual([
      "terra",
      "luna",
    ]);
    expect(
      resolveModels({ harness: "pi", models: ["zai/glm-5.4"], modelFamilies: { gpt: "openai" } }),
    ).toEqual(["zai/glm-5.4"]);
  });

  it("leaves Antigravity open to any name", () => {
    expect(resolveModels({ harness: "agy", modelAliases: { fast: "flash" } })).toBeUndefined();
  });
});

describe("expandBuiltInAlias", () => {
  it.each([
    [{ harness: "claude" }, "opus", "opus"],
    [{ harness: "codex" }, "sol", "gpt-{latest}-sol"],
    [{ harness: "agy" }, "flash", "gemini-{latest}-flash"],
    [{ harness: "pi", modelFamilies: { gpt: "openai" } }, "luna", "openai/gpt-{latest}-luna"],
    [
      { harness: "pi", modelFamilies: { claude: "anthropic" } },
      "opus",
      "anthropic/claude-opus-{latest}",
    ],
    [
      { harness: "pi", modelFamilies: { gemini: "openrouter/google" } },
      "neon",
      "openrouter/google/gemini-{latest}-neon",
    ],
    [{ harness: "pi", modelFamilies: { gpt: "openai" } }, "opus", "opus"],
    [{ harness: "pi" }, "sol", "sol"],
    [{ harness: "codex" }, "gpt-6.1-terra", "gpt-6.1-terra"],
  ] as const)("maps %j and %s to %s", (profile, model, selector) => {
    expect(expandBuiltInAlias(profile, model)).toBe(selector);
  });
});

describe("expandModelAlias", () => {
  it("expands exactly once and uses own alias properties", () => {
    const aliases = { fast: "sol", sol: "do-not-recurse" };
    expect(expandModelAlias("fast", aliases)).toBe("sol");
    expect(expandModelAlias("constructor", aliases)).toBe("constructor");
    expect(expandModelAlias(undefined, aliases)).toBeUndefined();
  });
});

describe("pattern resolution", () => {
  it.each([
    ["openai/gpt-{latest}-sol", "openai/gpt-6.2-sol"],
    ["anthropic/claude-opus-{latest}", "anthropic/claude-opus-5-5"],
    ["zai/glm-{latest}", "zai/glm-5.4"],
  ])("resolves %s to the newest whole-string match, %s", async (pattern, selector) => {
    const resolve = createExecutableModelResolver({ pi: async () => completed(PI_MODELS) });
    await expect(resolve("pi", pattern, CONTEXT)).resolves.toBe(selector);
  });

  it("rejects a Pi pattern without its provider", async () => {
    const resolve = createExecutableModelResolver({ pi: async () => completed(PI_MODELS) });
    await expect(resolve("pi", "gpt-{latest}-sol", CONTEXT)).rejects.toThrow(Error);
  });

  it("orders major and minor versions numerically", async () => {
    const slugs = [
      "gpt-5.9-astra",
      "gpt-6-astra",
      "gpt-5.9-terra",
      "gpt-5.10-terra",
      "gpt-6.1-luna",
      "gpt-99.1-sol",
    ];
    const resolve = createExecutableModelResolver({ codex: async () => codexCatalog(slugs) });
    await expect(resolve("codex", "gpt-{latest}-astra", CONTEXT)).resolves.toBe("gpt-6-astra");
    await expect(resolve("codex", "gpt-{latest}-terra", CONTEXT)).resolves.toBe("gpt-5.10-terra");
    await expect(resolve("codex", "gpt-{latest}-luna", CONTEXT)).resolves.toBe("gpt-6.1-luna");
  });

  it("rejects two models that share the newest version", async () => {
    const resolve = createExecutableModelResolver({
      codex: async () => codexCatalog(["m-6.1", "m-6.2", "m-6-2"]),
    });
    await expect(resolve("codex", "m-{latest}", CONTEXT)).rejects.toThrow(Error);
  });

  it("resolves the efforts of an Antigravity model to its base name, ignoring variants", async () => {
    const resolve = createExecutableModelResolver({ agy: async () => completed(AGY_MODELS) });
    await expect(resolve("agy", "gemini-{latest}-neon", CONTEXT)).resolves.toBe("gemini-4-neon");
    await expect(resolve("agy", "gemini-{latest}-carbon", CONTEXT)).resolves.toBe(
      "gemini-4-carbon",
    );
    await expect(resolve("agy", "gemini-{latest}-flash", CONTEXT)).resolves.toBe(
      "gemini-3.8-flash",
    );
    await expect(resolve("agy", "gemini-{latest}-flash-low", CONTEXT)).resolves.toBe(
      "gemini-3.8-flash",
    );
    const variantsOnly = "gemini-4-neon-lite-high\tLite\ngemini-pro-orchestrator-neon\tO\n";
    const resolveVariants = createExecutableModelResolver({
      agy: async () => completed(variantsOnly),
    });
    await expect(resolveVariants("agy", AGY_PATTERN, CONTEXT)).rejects.toThrow(Error);
  });

  it("skips discovery for an omitted model, a selector without {latest}, and Claude", async () => {
    const runner = vi.fn(async () => codexCatalog([]));
    const resolve = createExecutableModelResolver({ codex: runner, pi: runner, agy: runner });
    await expect(resolve("codex", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("pi", undefined, CONTEXT)).resolves.toBeUndefined();
    await expect(resolve("codex", "sol", CONTEXT)).resolves.toBe("sol");
    await expect(resolve("codex", "gpt-6.1-terra", CONTEXT)).resolves.toBe("gpt-6.1-terra");
    await expect(resolve("agy", "gemini-4-neon", CONTEXT)).resolves.toBe("gemini-4-neon");
    await expect(resolve("pi", " provider/model:high ", CONTEXT)).resolves.toBe(
      " provider/model:high ",
    );
    await expect(resolve("claude", "opus", CONTEXT)).resolves.toBe("opus");
    await expect(resolve("claude", "claude-opus-{latest}", CONTEXT)).resolves.toBe(
      "claude-opus-{latest}",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("reuses one successfully parsed catalog for several patterns", async () => {
    const runner = vi.fn(async () => codexCatalog(["gpt-6.1-terra", "gpt-5.7-luna"]));
    const resolve = createExecutableModelResolver({ codex: runner });
    await expect(resolve("codex", "gpt-{latest}-terra", CONTEXT)).resolves.toBe("gpt-6.1-terra");
    await expect(resolve("codex", "gpt-{latest}-luna", CONTEXT)).resolves.toBe("gpt-5.7-luna");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("never reuses catalogs from a different effective execution context", async () => {
    const runner = vi.fn(async (context: ModelDiscoveryContext) =>
      codexCatalog([context.env.CODEX_HOME === "a" ? "gpt-5-sol" : "gpt-9-sol"]),
    );
    const resolver = createExecutableModelResolver({ codex: runner });
    expect(
      await resolver("codex", CODEX_PATTERN, {
        cwd: "/a",
        env: { CODEX_HOME: "a", PATH: "/a/bin" },
      }),
    ).toBe("gpt-5-sol");
    expect(
      await resolver("codex", CODEX_PATTERN, {
        cwd: "/b",
        env: { CODEX_HOME: "b", PATH: "/b/bin" },
      }),
    ).toBe("gpt-9-sol");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("catalog failures", () => {
  it.each([
    ["process failure", async () => Promise.reject(new Error("ENOENT"))],
    ["nonzero exit", async () => ({ exitCode: 1, stdout: "", stderr: "" })],
    ["malformed JSON", async () => completed("{")],
    ["unexpected shape", async () => completed(JSON.stringify({ items: [] }))],
    ["malformed model", async () => completed(JSON.stringify({ models: [{}] }))],
    ["no matching model", async () => codexCatalog(["gpt-5.6-luna"])],
  ])("rejects %s", async (_name, runner) => {
    const resolve = createExecutableModelResolver({ codex: runner });
    const attempt = resolve("codex", CODEX_PATTERN, CONTEXT);
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
      const attempt = resolver("codex", CODEX_PATTERN, CONTEXT);
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
      const attempt = resolver("codex", CODEX_PATTERN, context);
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
        createExecutableModelResolver()("codex", CODEX_PATTERN, {
          cwd: root,
          env: { HOME: root, CODEX_HOME: root, PATH: root },
        }),
      ).rejects.toThrow(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Pi and Antigravity catalogs", () => {
  it.each([
    ["pi", PI_PATTERN, PI_MODELS.replaceAll("aligndev-models", "other-request")],
    ["pi", PI_PATTERN, PI_MODELS.replace('"success":true', '"success":false')],
    ["pi", PI_PATTERN, PI_MODELS.trimEnd()],
    ["agy", AGY_PATTERN, "gemini-4-neon-high Gemini 4 Neon (High)\n"],
  ] as const)("rejects malformed %s catalog output", async (agent, pattern, output) => {
    const resolve = createExecutableModelResolver({ [agent]: async () => completed(output) });
    await expect(resolve(agent, pattern, CONTEXT)).rejects.toThrow(Error);
  });

  it("keeps a failed Pi command out of the sign-in handoff", async () => {
    const resolve = createExecutableModelResolver({
      pi: async () => ({ exitCode: 7, stdout: piResponse([]), stderr: "" }),
    });
    const attempt = resolve("pi", PI_PATTERN, CONTEXT);
    await expect(attempt).rejects.toThrow(Error);
    await expect(attempt).rejects.not.toBeInstanceOf(ModelSignInRequiredError);
  });

  it("reads Pi's catalog over RPC and closes its input", async () => {
    await withFakePi(
      `process.stderr.write("[extension] provider  model  ready\\n");
${ANSWER_CATALOG_REQUEST}
process.stdin.on("end", () => process.exit(0));
`,
      async (resolve) => {
        await expect(resolve()).resolves.toBe("openai/gpt-6.2-sol");
      },
    );
  });

  it("counts Pi's output limit in bytes", async () => {
    await withFakePi(
      `process.stderr.write("é".repeat(4_500_000), () => {
${ANSWER_CATALOG_REQUEST.replace('[{ provider: "openai", id: "gpt-6.2-sol" }]', "[]")}
process.stdin.on("end", () => process.exit(0));
});
`,
      async (resolve) => {
        await expect(resolve()).rejects.not.toBeInstanceOf(ModelSignInRequiredError);
      },
    );
  });

  it("kills a Pi process that ignores SIGTERM before reporting the failure", async () => {
    await withFakePi(
      `process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(require("node:path").join(__dirname, "pid"), String(process.pid));
process.stderr.write("x".repeat(9_000_000));
setInterval(() => {}, 1000);
`,
      async (resolve, root) => {
        await expect(resolve()).rejects.toThrow(Error);
        const pid = Number(readFileSync(join(root, "pid"), "utf8"));
        expect(isRunning(pid)).toBe(false);
      },
    );
  }, 15_000);

  it("fails at once when a Pi extension opens a startup dialog", async () => {
    await withFakePi(
      `const request = { type: "extension_ui_request", id: "d", method: "confirm", title: "Trust?" };
process.stdout.write(JSON.stringify(request) + "\\n");
setInterval(() => {}, 1000);
`,
      async (resolve) => {
        await expect(resolve()).rejects.toBeInstanceOf(PiStartupDialogError);
      },
    );
  });

  it.each([
    [
      "a startup dialog that expires",
      `process.stdout.write(JSON.stringify({ ...DIALOG_REQUEST, timeout: 100 }) + "\\n");
${ANSWER_CATALOG_REQUEST}
process.stdin.on("end", () => process.exit(0));
`,
    ],
    [
      "a dialog after the response",
      `${ANSWER_CATALOG_REQUEST}
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(DIALOG_REQUEST) + "\\n", () => process.exit(0));
});
`,
    ],
  ])("resolves a Pi catalog despite %s", async (_name, script) => {
    await withFakePi(
      `const DIALOG_REQUEST = { type: "extension_ui_request", id: "d", method: "confirm", title: "T" };
${script}`,
      async (resolve) => {
        await expect(resolve()).resolves.toBe("openai/gpt-6.2-sol");
      },
    );
  });

  it("closes the output pipes that a descendant holds after the command exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "aligndev-catalog-pipe-"));
    try {
      const result = join(root, "result");
      // The helper inherits stderr and writes past the output limit once the command has exited.
      const helper = `const waitForParent = () => {
  try {
    process.kill(Number(process.argv[1]), 0);
    setTimeout(waitForParent, 10);
  } catch {
    process.stderr.on("error", () => {});
    process.stderr.write("x".repeat(9_000_000), (error) => {
      require("node:fs").writeFileSync(${JSON.stringify(result)}, error ? "closed" : "open");
    });
  }
};
waitForParent();`;
      writeFileSync(
        join(root, "codex"),
        `#!${process.execPath}
const args = ["-e", ${JSON.stringify(helper)}, String(process.pid)];
const stdio = ["ignore", "ignore", "inherit"];
require("node:child_process").spawn(process.execPath, args, { stdio }).unref();
`,
        { mode: 0o755 },
      );
      const context = { cwd: root, env: { HOME: root, CODEX_HOME: root, PATH: root } };
      const attempt = createExecutableModelResolver()("codex", CODEX_PATTERN, context);
      await expect(attempt).rejects.toThrow(Error);
      await vi.waitFor(() => expect(readFileSync(result, "utf8")).toBe("closed"), {
        timeout: 5_000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["pi", PI_PATTERN, completed(piResponse([]))],
    [
      "agy",
      AGY_PATTERN,
      {
        exitCode: 1,
        stdout: "",
        stderr: "Fetching available models...\nError: Please sign in to view available models.\n",
      },
    ],
  ] as const)("reports a %s catalog that requires sign-in", async (agent, pattern, output) => {
    const resolve = createExecutableModelResolver({ [agent]: async () => output });
    await expect(resolve(agent, pattern, CONTEXT)).rejects.toThrow(ModelSignInRequiredError);
  });
});

// Runs `test` with a resolver whose PATH holds only a `pi` executable running `script`.
async function withFakePi(
  script: string,
  test: (resolve: () => Promise<string | undefined>, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aligndev-pi-catalog-"));
  try {
    writeFileSync(join(root, "pi"), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    const resolver = createExecutableModelResolver();
    const context = { cwd: root, env: { HOME: root, PATH: root } };
    await test(() => resolver("pi", PI_PATTERN, context), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
