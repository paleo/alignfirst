// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Manifest expressions are literal fixtures.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import { adaptWorkspaceManifest } from "../src/manifest-adapter.js";
import { resolveDevPortsConfig } from "../src/ports.js";
import { writeDevServers } from "../src/dev-servers-registry.js";
import { type DevSetupInput, runDevSetup } from "../src/dev-setup.js";
import {
  findWorkspaceByPath,
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  updateWorkspaces,
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
  it.each([
    ["changed inputs", "patch"],
    ["explicit setup with the same inputs", "patch"],
    ["changed inputs", "source"],
  ])("reconciles after a partial failure during %s (failing %s)", async (scenario, failing) => {
    let host = "A";
    let fail = false;
    input.runFilesInputs = () => ({ host });
    const later = (content: string): string => {
      expect(currentEntry().runFilesWrittenWith).toBeUndefined();
      if (fail) throw new Error("later write failed");
      return content;
    };
    input.runFiles = [
      {
        path: "host.env",
        source: { kind: "content", content: "" },
        patch: () => `HOST=${host}\n`,
      },
      failing === "patch"
        ? { path: "later.env", source: { kind: "content", content: "later\n" }, patch: later }
        : { path: "later.env", source: { kind: "content", content: () => later("later\n") } },
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
    await expect(runDevSetup(input)).rejects.toThrow("later write failed");
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
  });

  it("generates dependent content in order on creation and rewrite", async () => {
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

    writeFileSync(filePath("derived.txt"), "hand edit\n");
    await runDevSetup(input);
    expect(fileContent("derived.txt")).toBe("hand edit\n");
    expect(generations).toBe(2);
    expect(currentEntry().runFilesWrittenWith).toEqual({
      ports: {},
      inputs: { host: fingerprintB },
    });
  });

  it("rewrites the run files before a start after the stored ports moved", async () => {
    input.ports = resolveDevPortsConfig({ first: 28200, last: 28299, declare: ["web"] });
    input.runFiles = [
      {
        path: "ports.env",
        source: { kind: "content", content: "# ports\n" },
        patch: (content, ctx) => `${content.split("\n")[0]}\nWEB_PORT=${ctx.ports.web}\n`,
      },
      {
        path: "ports.txt",
        source: { kind: "content", content: (ctx) => `web=${ctx.ports.web}\n` },
      },
    ];
    const first = await runDevSetup(input);
    const moved = first.ports.web === 28250 ? 28251 : 28250;
    const { mainWorktree } = input.worktree;
    await updateWorkspaces(mainWorktree, input.registryDir, (registry) => {
      registry.workspaces.main.ports = { web: moved };
    });
    await runDevSetup(input);
    expect(fileContent("ports.env")).toBe(`# ports\nWEB_PORT=${moved}\n`);
    expect(fileContent("ports.txt")).toBe(`web=${moved}\n`);
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: { web: moved }, inputs: {} });
  });

  it("refuses a linked worktree without a registry entry before any write", async () => {
    const linked = join(root, "linked");
    mkdirSync(linked);
    input.worktree = { ...input.worktree, currentWorktree: linked, isMainWorktree: false };
    input.runFiles = [{ path: "ports.env", source: { kind: "content", content: "x\n" } }];
    const setup = vi.fn();
    input.setup = setup;
    await expect(runDevSetup(input)).rejects.toThrow(WorkspaceError);
    expect(readWorkspaces(input.worktree.mainWorktree, input.registryDir).workspaces).toEqual({});
    expect(existsSync(join(linked, "ports.env"))).toBe(false);
    expect(setup).not.toHaveBeenCalled();
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
  });
});

describe("computed run-file inputs", () => {
  it("fingerprints invocation inputs and runs producers in order after ports, never storing values", async () => {
    const key = "SIDE32_INVOCATION_INPUT";
    const env: NodeJS.ProcessEnv = { ...process.env, [key]: "private-invocation-A" };
    const { devServer } = adaptWorkspaceManifest(
      {
        devServer: {
          ports: { first: 28100, last: 28199, declare: ["constructor", "__proto__", "fo-api"] },
          runFilesInputs: [key],
          runFiles: [
            { path: "first.txt", source: { kind: "content", content: "${{ ports.__proto__ }}" } },
            {
              path: "second.txt",
              source: {
                kind: "content",
                content: {
                  command: { run: ["sh", "-c", `cat first.txt; printf ' %s' "\${${key}-absent}"`] },
                },
              },
            },
          ],
          servers: [],
        },
      },
      { recipe: { kind: "defaults" }, mainWorktree: input.worktree.mainWorktree, env },
    );
    if (!devServer?.ports) throw new Error("Missing dev adapter");
    input.ports = resolveDevPortsConfig(devServer.ports);
    input.runFiles = devServer.runFiles ?? [];
    input.runFilesInputs = devServer.runFilesInputs;
    const result = await runDevSetup(input);
    const port = String(Reflect.get(result.ports, "__proto__"));
    expect(Object.keys(result.ports)).toEqual(["constructor", "__proto__", "fo-api"]);
    expect(currentEntry().ports).toEqual(result.ports);
    expect(fileContent("second.txt")).toBe(`${port} private-invocation-A`);
    expect(currentEntry().runFilesWrittenWith?.inputs[key]).toMatch(/^sha256:[a-f0-9]{64}$/);

    env[key] = "";
    await runDevSetup(input);
    expect(currentEntry().runFilesWrittenWith?.inputs[key]).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(fileContent("second.txt")).toBe(`${port} `);

    delete env[key];
    await runDevSetup(input);
    expect(currentEntry().runFilesWrittenWith?.inputs).toEqual({});
    expect(fileContent("second.txt")).toBe(`${port} absent`);
    const recorded = [
      readFileSync(filePath(`${input.registryDir}/workspaces.json`), "utf8"),
      ...vi.mocked(console.warn).mock.calls.flat(),
      ...vi.mocked(console.log).mock.calls.flat(),
    ].join("\n");
    expect(recorded).not.toContain("private-invocation-");

    input.runFilesInputs = undefined;
    input.ports = undefined;
    input.runFiles = [{ path: "first.txt", source: { kind: "content", content: "no ports" } }];
    await runDevSetup(input);
    expect(currentEntry().ports).toEqual({});
    expect(currentEntry().runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
  });
});

describe("port allocation and setup state", () => {
  it("avoids ports stored on other entries, runs setup once unless forced, and reallocates on reset", async () => {
    input.ports = resolveDevPortsConfig({ first: 28300, last: 28309, declare: ["web", "api"] });
    const runs: boolean[] = [];
    input.setup = (ctx) => void runs.push(ctx.force);
    const main = await runDevSetup(input);
    const { mainWorktree } = input.worktree;
    const linked = join(root, "linked");
    mkdirSync(linked);
    await registerWorkspace({
      currentWorktree: linked,
      mainWorktree,
      registryDir: input.registryDir,
      isMainWorktree: false,
      recipe: input.recipe,
    });
    await markWorkspaceReady(mainWorktree, input.registryDir, linked);
    input.worktree = { mainWorktree, currentWorktree: linked, isMainWorktree: false };
    const first = await runDevSetup(input);
    const mainPorts = Object.values(main.ports);
    expect(new Set([...mainPorts, ...Object.values(first.ports)]).size).toBe(4);
    expect((await runDevSetup(input)).ports).toEqual(first.ports);
    expect(runs).toEqual([false, false]);
    input.options.force = true;
    await runDevSetup(input);
    expect(runs).toEqual([false, false, true]);
    await updateWorkspaces(mainWorktree, input.registryDir, (registry) => {
      registry.workspaces.linked.ports = { web: 28308, api: 28309 };
    });
    input.options = { ...input.options, force: false, resetPorts: true };
    const reset = await runDevSetup(input);
    expect(reset.ports.web).toBeLessThan(28308);
    expect(Object.values(reset.ports).filter((port) => mainPorts.includes(port))).toEqual([]);
    expect(runs).toHaveLength(3);
  });
});

describe("registered main identity", () => {
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
    const before = currentEntry();
    await expect(runDevSetup(input)).rejects.toThrow(WorkspaceError);
    expect(currentEntry()).toEqual(before);
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
