import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseWorkspaceArgs } from "../src/cli.js";
import {
  type DevServerEntry,
  readDevServers,
  writeDevServers,
} from "../src/dev-servers-registry.js";
import type { WorkspaceHost, WorkspaceOperation } from "../src/operation.js";
import { resolveWorkspaceStorage, runtimeDirForTarget } from "../src/storage.js";
import {
  type PurgeContext,
  runWorkspace,
  type WorkspaceConfig,
  type WorkspaceOutcome,
} from "../src/workspace.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  registryDirFor,
  type WorkspaceEntry,
  type WorkspaceRecipe,
} from "../src/workspaces.js";

/**
 * A temporary Git repository driven in-process through `runWorkspace`, with a host stub and a shim
 * installed CLI. The shim exits at once: it runs no finalize, `dev setup` or `dev down`. Call the
 * finalize path in-process instead (`finalize`).
 */
export interface KernelFixture {
  root: string;
  repo: string;
  /** Text, diagnostics and raw writes, in order. */
  output: string[];
  /** Every `purgeInfrastructure` call of a fixture-built config. */
  purges: PurgeContext[];
  env: NodeJS.ProcessEnv;
  /** Main's selection. `host.loadWorkspace` returns it unless `configs` holds the target. */
  config: WorkspaceConfig;
  /** Per-target selection, keyed by canonical worktree path. */
  configs: Map<string, WorkspaceConfig>;
  host: WorkspaceHost;
  operation: WorkspaceOperation;
}

export interface KernelFixtureOptions {
  /** A repository without its initial commit; `README.md` stays untracked. */
  unborn?: boolean;
}

export const MANIFEST_RECIPE: WorkspaceRecipe = {
  kind: "manifest",
  file: "alignfirst.json",
  in: "project",
};
const fixtures: KernelFixture[] = [];
const sleepers: number[] = [];

export function createKernelFixture(options: KernelFixtureOptions = {}): KernelFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-kernel-")));
  const repo = join(root, "app");
  mkdirSync(join(repo, ".plans"), { recursive: true });
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "README.md"), "project\n");
  writeFileSync(join(repo, ".gitignore"), "/.plans\n/.local-wt/\n");
  if (!options.unborn) commit(repo);
  const output: string[] = [];
  const purges: PurgeContext[] = [];
  const configs = new Map<string, WorkspaceConfig>();
  const env = { ...process.env };
  const host: WorkspaceHost = {
    loadWorkspace: (worktree) => configs.get(canonical(worktree)) ?? fixture.config,
    validateWorkFiles: () => {},
    sharedDirectoryProtection: (worktree) => ({
      plans: { path: join(worktree, ".plans"), in: "project" },
      protectedPaths: existsSync(join(worktree, ".plans"))
        ? [realpathSync(join(worktree, ".plans"))]
        : [],
    }),
  };
  const fixture: KernelFixture = {
    root,
    repo,
    output,
    purges,
    env,
    config: workspaceConfig(purges),
    configs,
    host,
    operation: {
      cwd: repo,
      env,
      invocation: installShim(root),
      output: {
        text: (message) => output.push(message),
        diagnostic: (message) => output.push(message),
        write: (text) => output.push(text),
        isTTY: false,
      },
      host,
    },
  };
  fixtures.push(fixture);
  return fixture;
}

/** Call from `afterEach`. */
export function removeKernelFixtures(): void {
  for (const pid of sleepers.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already stopped by the kernel.
    }
  }
  for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
}

/** A defaults recipe whose purge records its context into `purges`. */
export function workspaceConfig(
  purges: PurgeContext[],
  overrides: Partial<WorkspaceConfig> = {},
): WorkspaceConfig {
  return {
    recipe: { kind: "defaults" },
    hasDevServer: false,
    sharedDirs: [],
    runtimeDir: ".local-wt",
    gitignoredFiles: [],
    purgeInfrastructure: ({ signal: _signal, ...ctx }) => {
      purges.push(ctx);
    },
    formatSummary: ({ name }) => `summary ${name}`,
    ...overrides,
  };
}

export interface RunOptions {
  cwd?: string;
  /** Overrides the config passed to `runWorkspace`; the host still selects per target. */
  config?: WorkspaceConfig;
}

export function runKernel(
  fixture: KernelFixture,
  args: string[],
  options: RunOptions = {},
): Promise<WorkspaceOutcome | undefined> {
  const cwd = options.cwd ?? fixture.repo;
  const config = options.config ?? fixture.host.loadWorkspace?.(cwdRoot(cwd)) ?? fixture.config;
  return runWorkspace(config, { ...fixture.operation, cwd, ...parseWorkspaceArgs(args) });
}

/** Runs the detached finalizer's work in-process, adopting the published preparation token. */
export async function finalize(
  fixture: KernelFixture,
  worktree: string,
  flags: string[] = [],
): Promise<void> {
  const token = requiredEntry(fixture, worktree).entry.preparationOwner?.token;
  if (token === undefined) throw new Error(`No preparation owner for ${worktree}`);
  await runKernel(fixture, ["__finalize", "--preparation-token", token, ...flags], {
    cwd: worktree,
  });
}

export function registryDir(fixture: KernelFixture): string {
  return fixture.config.storage?.registryDir ?? join(fixture.repo, registryDirFor(".local-wt"));
}

/** Selects external runtime storage under `<root>/companion` for main and every target. */
export function useCompanionRuntime(fixture: KernelFixture): string {
  const companionDir = join(fixture.root, "companion");
  mkdirSync(companionDir, { recursive: true });
  fixture.config.storage = resolveWorkspaceStorage(
    { in: "companion", mainWorktree: fixture.repo, companionDir },
    fixture.repo,
  );
  return companionDir;
}

export function runtimeDirOf(fixture: KernelFixture, worktree: string): string {
  return runtimeDirForTarget(fixture.config, worktree);
}

export function entryAt(
  fixture: KernelFixture,
  worktree: string,
): { name: string; entry: WorkspaceEntry } | undefined {
  if (!existsSync(join(registryDir(fixture), "workspaces.json"))) return;
  return findWorkspaceByPath(readWorkspaces(fixture.repo, registryDir(fixture)), worktree);
}

export function requiredEntry(
  fixture: KernelFixture,
  worktree: string,
): { name: string; entry: WorkspaceEntry } {
  const found = entryAt(fixture, worktree);
  if (!found) throw new Error(`No workspace registered at ${worktree}`);
  return found;
}

export function addWorktree(fixture: KernelFixture, path: string, branch: string): string {
  const worktree = join(fixture.root, path);
  mkdirSync(dirname(worktree), { recursive: true });
  git(fixture.repo, "worktree", "add", "--quiet", "-b", branch, worktree);
  return worktree;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.org", ...args],
    { cwd, encoding: "utf8", stdio: "pipe" },
  );
}

export function commit(repo: string, message = "fixture"): void {
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
}

/** A detached process group leader that `removeKernelFixtures` kills. */
export function sleeper(): number {
  const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("Could not start a sleeper");
  sleepers.push(child.pid);
  return child.pid;
}

/** Registers a PID started by the kernel so `removeKernelFixtures` kills its group. */
export function ownProcess(pid: number): void {
  sleepers.push(pid);
}

export function devEntry(name: string, worktree: string, pid = 2_147_483_647): DevServerEntry {
  return { name, worktree, pids: { app: pid }, startedAt: "2026-01-01T00:00:00.000Z" };
}

export function writeDevEntries(fixture: KernelFixture, servers: DevServerEntry[]): void {
  mkdirSync(registryDir(fixture), { recursive: true });
  writeDevServers(fixture.repo, registryDir(fixture), { servers });
}

export function devEntries(fixture: KernelFixture): DevServerEntry[] {
  return readDevServers(fixture.repo, registryDir(fixture)).servers;
}

/** The next `count` purges of main's selection throw after recording their context. */
export function failPurges(fixture: KernelFixture, count: number): void {
  let remaining = count;
  fixture.config.purgeInfrastructure = ({ signal: _signal, ...ctx }) => {
    fixture.purges.push(ctx);
    if (remaining > 0) {
      --remaining;
      throw new Error("purge failed");
    }
  };
}

/** A PID that no live process holds. */
export function exitedPid(): number {
  return Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }));
}

function installShim(root: string): { executable: string; entryPoint: string } {
  const executable = join(root, "runtime");
  const entryPoint = join(root, "installed-cli.mjs");
  symlinkSync(process.execPath, executable);
  writeFileSync(entryPoint, "process.exit(0);\n");
  return { executable, entryPoint };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function cwdRoot(cwd: string): string {
  try {
    return git(cwd, "rev-parse", "--show-toplevel").trim();
  } catch {
    return cwd;
  }
}
