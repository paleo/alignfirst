import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDevServers } from "../src/dev-servers-registry.js";
import { parseWorkspaceArgs } from "../src/cli.js";
import { installedCliCommand, renderWorkspaceCommands } from "../src/invocation.js";
import type { WorkspaceOperation } from "../src/operation.js";
import { runWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import {
  findWorkspaceByPath,
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
} from "../src/workspaces.js";

let root: string;
let config: WorkspaceConfig;
let operation: WorkspaceOperation;
let capture: string;
let output: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installed-cli-"));
  execFileSync("git", ["init", "-q", root]);
  const executable = join(root, "runtime with spaces");
  const entryPoint = join(root, "installed cli with spaces.mjs");
  symlinkSync(process.execPath, executable);
  capture = join(root, "child.json");
  writeFileSync(
    entryPoint,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.MARKER }));
console.log("child progress");
process.exit(Number(process.env.CHILD_EXIT ?? 0));
`,
  );
  output = [];
  operation = {
    cwd: root,
    env: { ...process.env, CAPTURE: capture, MARKER: "explicit environment" },
    invocation: { executable, entryPoint },
    output: {
      text: (text) => output.push(text),
      diagnostic: (text) => output.push(text),
      write: (text) => output.push(text),
      isTTY: false,
    },
  };
  config = {
    runtimeDir: ".local-wt",
    sharedDirs: [],
    gitignoredFiles: [],
    recipe: { kind: "defaults" },
    hasDevServer: true,
    formatSummary: () => "workspace summary",
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function captured(): { argv: string[]; cwd: string; marker: string } {
  return JSON.parse(readFileSync(capture, "utf8"));
}

function currentEntry() {
  return findWorkspaceByPath(readWorkspaces(root, registryDirFor(config.runtimeDir)), root)?.entry;
}

describe("installed CLI boundary", () => {
  it("keeps exact runtime/bin argv, including spaces, independently from public runner hints", () => {
    expect(installedCliCommand(operation.invocation, ["workspace", "__finalize"])).toEqual({
      executable: join(root, "runtime with spaces"),
      args: [join(root, "installed cli with spaces.mjs"), "workspace", "__finalize"],
    });
    expect(() =>
      installedCliCommand({ executable: "npx", entryPoint: "alignfirst" }, ["dev", "down"]),
    ).toThrow("absolute");
    const commands = renderWorkspaceCommands({
      runtime: "bun",
      executable: operation.invocation.executable,
      cwd: root,
      env: { npm_config_user_agent: "npm/11" },
    });
    expect(commands.workspace.withArgs).toBe("bunx --bun alignfirst workspace");
    expect(commands.dev.withArgs).toBe("bunx --bun alignfirst dev");
  });

  it("full setup routes child progress separately, forwards flags/env/cwd, and retries dev failure with preparation ready", async () => {
    operation.env.CHILD_EXIT = "7";
    await expect(
      runWorkspace(config, {
        ...operation,
        ...parseWorkspaceArgs(["setup", "--full", "--force", "--verbose"]),
      }),
    ).rejects.toThrow("dev setup failed");
    expect(captured()).toEqual({
      argv: [operation.invocation.entryPoint, "dev", "setup", "--force", "--verbose"],
      cwd: root,
      marker: "explicit environment",
    });
    expect(currentEntry()?.status).toBe("ready");
    expect(currentEntry()?.devSetupFailure?.message).toContain("code 7");
    await expect(
      runWorkspace(config, { ...operation, ...parseWorkspaceArgs(["wait"]) }),
    ).rejects.toThrow("dev setup failed");
    operation.env.CHILD_EXIT = "0";
    const result = await runWorkspace(config, {
      ...operation,
      ...parseWorkspaceArgs(["setup", "--full"]),
    });
    expect(result).toMatchObject({ worktree: root, status: "ready" });
    expect(currentEntry()?.devSetupFailure).toBeUndefined();
    expect(output.join("\n")).toContain("child progress");
  });

  it("default-only preparation completes without spawning an empty finalizer", async () => {
    config.hasDevServer = false;
    const result = await runWorkspace(config, {
      ...operation,
      ...parseWorkspaceArgs(["setup", "--detached"]),
    });
    expect(result).toMatchObject({ worktree: root, status: "ready" });
    expect(existsSync(capture)).toBe(false);
    expect(output.join("\n")).not.toContain("Setup continuing in background");
    await expect(
      runWorkspace(config, { ...operation, ...parseWorkspaceArgs(["setup", "--full"]) }),
    ).rejects.toThrow("requires declared dev services");
  });

  it.each([true, false])(
    "detached full setup retains target cwd and flags, with finalize steps=%s",
    async (hasFinalizeSteps) => {
      config.finalizeWorkspace = hasFinalizeSteps
        ? () => {
            throw new Error("Finalization belongs to the child");
          }
        : undefined;
      const result = await runWorkspace(config, {
        ...operation,
        ...parseWorkspaceArgs(["setup", "--full", "--force", "--verbose", "--detached"]),
      });
      expect(result).toMatchObject({ status: "pending" });
      await expect.poll(() => existsSync(capture)).toBe(true);
      expect(captured()).toMatchObject({
        argv: [
          operation.invocation.entryPoint,
          "workspace",
          "__finalize",
          "--preparation-token",
          expect.any(String),
          "--force",
          "--full",
          "--verbose",
        ],
        cwd: root,
      });
    },
  );

  it("finalize reports step progress and records a dev failure without failing preparation", async () => {
    const preparationOwner = { pid: process.pid, token: "test-handoff" };
    await registerWorkspace({
      preparationOwner,
      currentWorktree: root,
      mainWorktree: root,
      registryDir: registryDirFor(config.runtimeDir),
      isMainWorktree: true,
      recipe: config.recipe,
    });
    let verbose: boolean | undefined;
    config.finalizeWorkspace = (ctx) => {
      verbose = ctx.verbose;
      ctx.progress("build");
    };
    operation.env.CHILD_EXIT = "9";
    await runWorkspace(config, {
      ...operation,
      ...parseWorkspaceArgs([
        "__finalize",
        "--preparation-token",
        preparationOwner.token,
        "--full",
        "--force",
        "--verbose",
      ]),
    });
    expect(verbose).toBe(true);
    expect(captured().argv).toEqual([
      operation.invocation.entryPoint,
      "dev",
      "setup",
      "--from-finalize",
      "--force",
      "--verbose",
    ]);
    expect(currentEntry()?.status).toBe("ready");
    expect(currentEntry()?.devSetupFailure?.message).toContain("code 9");
    expect(existsSync(join(root, ".local-wt/logs/workspace-setup.progress"))).toBe(false);
  });

  it("dispatches a stop child through the installed CLI in the actual target cwd", async () => {
    const target = join(root, "stop target");
    mkdirSync(target);
    await registerWorkspace({
      currentWorktree: target,
      mainWorktree: root,
      registryDir: registryDirFor(config.runtimeDir),
      isMainWorktree: false,
      recipe: config.recipe,
    });
    writeDevServers(root, registryDirFor(config.runtimeDir), {
      servers: [
        { name: "stop target", worktree: target, pids: {}, startedAt: "2026-05-10T00:00:00.000Z" },
      ],
    });
    await markWorkspaceReady(root, registryDirFor(config.runtimeDir), target);
    await runWorkspace(config, { ...operation, ...parseWorkspaceArgs(["teardown", target]) });
    expect(captured()).toMatchObject({
      argv: [operation.invocation.entryPoint, "dev", "down", "--retain-cleanup"],
      cwd: target,
    });
  });

  it("refuses a dev-only record without durable recipe identity before cleanup", async () => {
    const target = join(root, "dev-only");
    mkdirSync(target);
    writeFileSync(join(target, "alignfirst.jsonc"), '{"schemaVersion":1,}');
    writeDevServers(root, registryDirFor(config.runtimeDir), {
      servers: [
        {
          name: "registered-name",
          worktree: target,
          pids: {},
          startedAt: "2026-05-10T00:00:00.000Z",
        },
      ],
    });
    config.hasDevServer = false;
    config.purgeInfrastructure = () => {
      throw new Error("purge failed");
    };
    await expect(
      runWorkspace(config, { ...operation, ...parseWorkspaceArgs(["teardown", target]) }),
    ).rejects.toThrow("Missing durable workspace recipe identity");
    const recovered = findWorkspaceByPath(
      readWorkspaces(root, registryDirFor(config.runtimeDir)),
      target,
    );
    expect(recovered).toBeUndefined();
  });

  it("re-executes removal outside the current target with fixed argv", async () => {
    const target = join(root, "linked target");
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.org",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ],
      { cwd: root },
    );
    execFileSync("git", ["worktree", "add", "-qb", "linked", target], { cwd: root });
    await registerWorkspace({
      currentWorktree: target,
      mainWorktree: root,
      registryDir: registryDirFor(config.runtimeDir),
      isMainWorktree: false,
      recipe: config.recipe,
    });
    await runWorkspace(config, {
      ...operation,
      cwd: target,
      ...parseWorkspaceArgs(["remove", "--force", "--verbose"]),
    });
    expect(captured()).toMatchObject({
      argv: [
        operation.invocation.entryPoint,
        "workspace",
        "remove",
        target,
        "--force",
        "--verbose",
      ],
      cwd: root,
    });
    expect(existsSync(target)).toBe(true); // The shim records dispatch; public lifecycle acceptance belongs to A6/A7.
  });
});
