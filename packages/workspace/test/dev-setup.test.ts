// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Manifest expressions are literal fixtures.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adaptWorkspaceManifest } from "../src/manifest-adapter.js";
import { resolveDevPortsConfig } from "../src/ports.js";
import { writeDevServers } from "../src/dev-servers-registry.js";
import { type DevSetupInput, runDevSetup } from "../src/dev-setup.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  updateWorkspaces,
  workspaceRecipe,
} from "../src/workspaces.js";

const fingerprintA = "sha256:559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd";
const fingerprintB = "sha256:df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";

let root: string;
let input: DevSetupInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dev-setup-"));
  const mainWorktree = join(root, "main");
  mkdirSync(mainWorktree);
  input = {
    worktree: { currentWorktree: mainWorktree, mainWorktree, isMainWorktree: true },
    recipe: { kind: "defaults" },
    output: {
      text: (message) => console.log(message),
      diagnostic: (message) => console.warn(message),
      write: () => {},
      isTTY: false,
    },
    registryDir: registryDirFor(".wt"),
    runtimeDir: ".wt",
    runFiles: [],
    options: { force: false, resetPorts: false, fromFinalize: false, beforeStart: true },
  };
  vi.spyOn(process, "cwd").mockImplementation(() => input.worktree.currentWorktree);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("run-file write batches", () => {
  it.each(["changed inputs", "explicit setup with the same inputs"])(
    "reconciles after a partial failure during %s",
    async (scenario) => {
      let host = "A";
      let fail = false;
      input.runFilesInputs = () => ({ host });
      input.runFiles = [
        {
          path: "host.env",
          source: { kind: "content", content: "" },
          patch: () => `HOST=${host}\n`,
        },
        {
          path: "later.env",
          source: { kind: "content", content: "later\n" },
          patch: (content) => {
            expect(currentEntry().runFilesWrittenWith).toBeUndefined();
            if (fail) throw new Error("later patch failed");
            return content;
          },
        },
      ];
      await runDevSetup(input);
      expect(currentEntry().runFilesWrittenWith).toEqual({
        ports: {},
        inputs: { host: fingerprintA },
      });

      if (scenario === "changed inputs") host = "B";
      else {
        input.options.beforeStart = false;
        writeFileSync(filePath("host.env"), "HOST=hand-edit\n");
      }
      fail = true;
      await expect(runDevSetup(input)).rejects.toThrow("later patch failed");
      expect(fileContent("host.env")).toBe(`HOST=${host}\n`);
      expect(currentEntry().runFilesWrittenWith).toBeUndefined();

      host = "A";
      fail = false;
      input.options.beforeStart = true;
      await runDevSetup(input);
      expect(fileContent("host.env")).toBe("HOST=A\n");
      expect(currentEntry().runFilesWrittenWith).toEqual({
        ports: {},
        inputs: { host: fingerprintA },
      });
      expect(currentEntry().devSetupFailure).toBeUndefined();
    },
  );

  it("generates dependent content in order on creation and rewrite, with one update message", async () => {
    let host = "A";
    let generations = 0;
    input.runFilesInputs = () => ({ host });
    input.runFiles = [
      {
        path: "host.env",
        source: { kind: "content", content: "" },
        patch: () => `HOST=${host}\n`,
      },
      {
        path: "derived.txt",
        source: {
          kind: "content",
          content: async () => {
            ++generations;
            return fileContent("host.env");
          },
        },
      },
    ];
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("HOST=A\n");

    host = "B";
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("HOST=B\n");
    expect(generations).toBe(2);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run-file inputs changed (host). Updated host.env, derived.txt.",
    );

    writeFileSync(filePath("derived.txt"), "hand edit\n");
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("hand edit\n");
    expect(generations).toBe(2);
    expect(currentEntry().runFilesWrittenWith).toEqual({
      ports: {},
      inputs: { host: fingerprintB },
    });
  });

  it("reports preceding updates when a later generated source fails", async () => {
    let host = "A";
    let fail = false;
    input.runFilesInputs = () => ({ host });
    input.runFiles = [
      { path: "host.env", source: { kind: "content", content: () => `HOST=${host}\n` } },
      {
        path: "later.txt",
        source: {
          kind: "content",
          content: () => {
            if (fail) throw new Error("generation failed");
            return "later\n";
          },
        },
      },
    ];
    await runDevSetup(input);
    host = "B";
    fail = true;
    await expect(runDevSetup(input)).rejects.toThrow("generation failed");
    expect(fileContent("host.env")).toBe("HOST=B\n");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run-file inputs changed (host). Updated host.env.",
    );
    expect(currentEntry().runFilesWrittenWith).toBeUndefined();
  });

  it("updates run files before provisioning infrastructure after a main-directory rename", async () => {
    const provisioned: string[] = [];
    input.runFiles = [
      {
        path: "container.env",
        source: { kind: "content", content: "" },
        patch: (_content, ctx) => `CONTAINER=${ctx.name}-database\n`,
      },
    ];
    input.setup = (ctx) => {
      expect(fileContent("container.env")).toBe(`CONTAINER=${ctx.name}-database\n`);
      provisioned.push(ctx.name);
    };
    await runDevSetup(input);
    const renamed = join(root, "renamed");
    renameSync(input.worktree.mainWorktree, renamed);
    input.worktree = { currentWorktree: renamed, mainWorktree: renamed, isMainWorktree: true };

    await runDevSetup(input);
    expect(fileContent("container.env")).toBe("CONTAINER=renamed-database\n");
    expect(provisioned).toEqual(["main", "renamed"]);
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Warning: the run files had no recorded ports or inputs. Updated container.env.",
    );
  });
});

describe("computed run-file inputs", () => {
  it("runs command producers in order after ports, fingerprints inputs and detects removal", async () => {
    const secret = "private-host-value";
    const { devServer } = adaptWorkspaceManifest(
      {
        schemaVersion: 1,
        devServer: {
          ports: { first: 28100, last: 28199, declare: ["constructor", "__proto__", "fo-api"] },
          runFilesInputs: {
            command: {
              run: [
                process.execPath,
                "-e",
                "process.stdout.write(JSON.stringify({host:process.env.HOST}))",
              ],
              env: { HOST: secret },
            },
          },
          runFiles: [
            { path: "first.txt", source: { kind: "content", content: "${{ ports.__proto__ }}" } },
            {
              path: "second.txt",
              source: {
                kind: "content",
                content: {
                  command: {
                    run: [
                      process.execPath,
                      "-e",
                      "process.stdout.write(require('fs').readFileSync('first.txt'))",
                    ],
                  },
                },
              },
            },
          ],
          servers: [],
        },
      },
      { mainWorktree: input.worktree.mainWorktree },
    );
    if (!devServer?.ports) throw new Error("Missing dev adapter");
    input.ports = resolveDevPortsConfig(devServer.ports);
    input.runFiles = devServer.runFiles ?? [];
    input.runFilesInputs = devServer.runFilesInputs;
    const result = await runDevSetup(input);
    expect(Object.keys(result.ports)).toEqual(["constructor", "__proto__", "fo-api"]);
    expect(currentEntry().ports).toEqual(result.ports);
    expect(fileContent("second.txt")).toBe(String(Reflect.get(result.ports, "__proto__")));
    expect(currentEntry().runFilesWrittenWith?.inputs.host).toMatch(/^sha256:[a-f0-9]{64}$/);
    const registryText = readFileSync(filePath(`${input.registryDir}/workspaces.json`), "utf8");
    expect(registryText).not.toContain(secret);
    input.runFilesInputs = async () => ({ host: "" });
    await runDevSetup(input);
    expect(currentEntry().runFilesWrittenWith?.inputs.host).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    input.runFilesInputs = undefined;
    input.ports = undefined;
    input.runFiles = [{ path: "first.txt", source: { kind: "content", content: "no ports" } }];
    await runDevSetup(input);
    expect(currentEntry().ports).toEqual({});
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("inputs changed (host)"));
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).not.toContain(secret);
  });
});

describe("registered main identity", () => {
  it("records the selected recipe on automatic main creation and refuses a missing registered manifest", async () => {
    const path = join(input.worktree.mainWorktree, "alignfirst-workspace.json");
    writeFileSync(path, '{"schemaVersion":1}');
    input.recipe = workspaceRecipe(input.worktree.mainWorktree);
    await runDevSetup(input);
    expect(currentEntry().recipe).toEqual({ kind: "manifest", file: "alignfirst-workspace.json" });
    renameSync(path, `${path}c`);
    input.recipe = workspaceRecipe(input.worktree.mainWorktree);
    await runDevSetup(input);
    rmSync(`${path}c`);
    input.recipe = { kind: "defaults" };
    await expect(runDevSetup(input)).rejects.toThrow("manifest recipe is missing");
    expect(currentEntry().recipe.kind).toBe("manifest");
  });

  it("shares allocation with registration and preserves a suffix, ports and setup state", async () => {
    input.ports = resolveDevPortsConfig({ first: 8200, last: 8299, declare: ["web"] });
    const { mainWorktree } = input.worktree;
    await registerWorkspace({
      currentWorktree: "/external/main",
      mainWorktree,
      registryDir: input.registryDir,
      isMainWorktree: false,
      recipe: { kind: "defaults" },
    });
    const provisioned: string[] = [];
    input.setup = (ctx) => {
      provisioned.push(ctx.name);
    };
    input.runFiles = [
      { path: "name.env", source: { kind: "content", content: (ctx) => ctx.name } },
    ];
    const first = await runDevSetup(input);
    expect(first.workspace.name).toMatch(/^main-[a-f0-9]{8}$/);
    expect(currentEntry().neverFinalized).toBe(true);
    await updateWorkspaces(mainWorktree, input.registryDir, (registry) => {
      delete registry.workspaces.main;
      registry.workspaces[first.workspace.name].ports = { web: 8200 };
    });
    const moved = join(root, "elsewhere", "main");
    mkdirSync(join(root, "elsewhere"));
    renameSync(mainWorktree, moved);
    input.worktree = { currentWorktree: moved, mainWorktree: moved, isMainWorktree: true };
    const second = await runDevSetup(input);
    expect(second.workspace.name).toBe(first.workspace.name);
    expect(second.ports).toEqual({ web: 8200 });
    expect(provisioned).toEqual([first.workspace.name]);
    expect(fileContent("name.env")).toBe(first.workspace.name);
    const registered = await registerWorkspace({
      ...input.worktree,
      registryDir: input.registryDir,
      recipe: { kind: "defaults" },
    });
    expect(registered).toEqual({ name: first.workspace.name, status: "pending" });
    expect(currentEntry().neverFinalized).toBeUndefined();
  });

  it("checks the detected root for reset-ports even when invoked from a nested directory", async () => {
    await runDevSetup(input);
    const { mainWorktree } = input.worktree;
    mkdirSync(join(mainWorktree, "nested"));
    vi.mocked(process.cwd).mockReturnValue(join(mainWorktree, "nested"));
    writeDevServers(mainWorktree, input.registryDir, {
      servers: [
        {
          name: "main",
          worktree: mainWorktree,
          pids: { web: process.pid },
          startedAt: new Date().toISOString(),
        },
      ],
    });
    input.options.resetPorts = true;
    await expect(runDevSetup(input)).rejects.toThrow("dev-server of this worktree is running");
  });
});

function currentEntry() {
  const { mainWorktree, currentWorktree } = input.worktree;
  const found = findWorkspaceByPath(
    readWorkspaces(mainWorktree, input.registryDir),
    currentWorktree,
  );
  if (!found) throw new Error("No current entry");
  return found.entry;
}

function fileContent(path: string): string {
  return readFileSync(filePath(path), "utf-8");
}

function filePath(path: string): string {
  return join(input.worktree.currentWorktree, path);
}
