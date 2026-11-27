import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  PiStartupDialogError,
  resolveModels,
} from "../../src/code/models.js";

const CONTEXT = { cwd: "/project", env: { PATH: "/bin" } };
const PI_MODELS = piResponse([
  ["openai", "gpt-6.1-sol"],
  ["openai", "gpt-6.2-sol"],
  ["openai", "gpt-6.2-sol-healthcare"],
  ["openai", "gpt-6.10-sol-healthcare"],
  ["openai", "gpt-5.6-terra"],
]);
const AGY_MODELS = [
  "gemini-4-carbon-max\tGemini 4 Carbon (Max)",
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-lite-high\tGemini 4 Neon Lite (High)",
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
    await expect(resolve("agy", "custom-model", CONTEXT)).resolves.toBe("custom-model");
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
      pi: async () =>
        completed(
          piResponse([
            ["openai", "gpt-6.2-sol"],
            ["openrouter", "gpt-6.2-sol"],
          ]),
        ),
    });
    await expect(resolve("pi", "sol", CONTEXT)).rejects.toThrow(Error);
  });

  it("resolves an Antigravity alias to the newest base name, ignoring variants", async () => {
    const resolve = createExecutableModelResolver({ agy: async () => completed(AGY_MODELS) });
    await expect(resolve("agy", "neon", CONTEXT)).resolves.toBe("gemini-4-neon");
    await expect(resolve("agy", "carbon", CONTEXT)).resolves.toBe("gemini-4-carbon");
    await expect(resolve("agy", "flash", CONTEXT)).resolves.toBe("gemini-3.8-flash");
    const variantsOnly = "gemini-4-neon-lite-high\tLite\ngemini-pro-orchestrator-neon\tO\n";
    const resolveVariants = createExecutableModelResolver({
      agy: async () => completed(variantsOnly),
    });
    await expect(resolveVariants("agy", "neon", CONTEXT)).rejects.toThrow(Error);
  });

  it.each([
    ["pi", "sol", PI_MODELS.replaceAll("aligndev-models", "other-request")],
    ["pi", "sol", PI_MODELS.replace('"success":true', '"success":false')],
    ["pi", "sol", PI_MODELS.trimEnd()],
    ["agy", "neon", "gemini-4-neon-high Gemini 4 Neon (High)\n"],
  ] as const)("rejects malformed %s catalog output", async (agent, alias, output) => {
    const resolve = createExecutableModelResolver({ [agent]: async () => completed(output) });
    await expect(resolve(agent, alias, CONTEXT)).rejects.toThrow(Error);
  });

  it("keeps a failed Pi command out of the sign-in handoff", async () => {
    const resolve = createExecutableModelResolver({
      pi: async () => ({ exitCode: 7, stdout: piResponse([]), stderr: "" }),
    });
    const attempt = resolve("pi", "sol", CONTEXT);
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
      await expect(createExecutableModelResolver()("codex", "sol", context)).rejects.toThrow(Error);
      await vi.waitFor(() => expect(readFileSync(result, "utf8")).toBe("closed"), {
        timeout: 5_000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["pi", "sol", completed(piResponse([]))],
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
    await test(() => resolver("pi", "sol", context), root);
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
