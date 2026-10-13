import { basename } from "node:path";

import { findOwnEntry } from "./dev-servers-registry.js";
import { ConfigError, WorkspaceError } from "./errors.js";
import {
  type RunFileContext,
  type RunFileEntry,
  type SetupContextBase,
  seedFiles,
} from "./file-entries.js";
import { formatDuration, setupLogPath } from "./helpers.js";
import { devCmd, type PackageManagerCommands, packageManagerCommands } from "./package-manager.js";
import { formatPorts, isPortFree, type ResolvedDevPorts, reconcilePorts } from "./ports.js";
import { isProcessAlive } from "./process-control.js";
import {
  readWorkspaces,
  rekeyMainEntry,
  resolveCurrentWorkspace,
  type ResolvedWorkspace,
  updateWorkspaces,
  warnMainRenamed,
  type WorkspaceEntry,
  type WorkspacesRegistry,
} from "./workspaces.js";
import type { WorktreeContext } from "./worktree.js";

/** Context passed to `DevServerConfig.setup`. */
export interface DevSetupContext extends SetupContextBase {
  ports: Record<string, number>;
  /** Mirrors `dev setup --force`. */
  force: boolean;
  log: (msg: string) => void;
}

export interface DevSetupInput {
  worktree: WorktreeContext;
  registryDir: string;
  runtimeDir: string;
  /** Omit for a portless dev-server. */
  ports?: ResolvedDevPorts;
  runFiles: RunFileEntry[];
  setup?: (ctx: DevSetupContext) => Promise<void> | void;
  options: DevSetupOptions;
}

export interface DevSetupOptions {
  /** Reruns `setup`. */
  force: boolean;
  /** Allocates every port again, pins excepted. */
  resetPorts: boolean;
  /** Set only by the finalize child of `workspace setup --full`: a `pending` workspace passes. */
  fromFinalize: boolean;
}

export interface DevSetupResult {
  workspace: ResolvedWorkspace;
  ports: Record<string, number>;
}

/**
 * `dev setup`, explicit or implicit before each start: resolves the workspace, reconciles its
 * ports, writes the run files, and runs the `setup` hook once per workspace. A failure after the
 * ready check is recorded as the entry's `devSetupFailure`.
 */
export async function runDevSetup(input: DevSetupInput): Promise<DevSetupResult> {
  const { worktree, registryDir, options } = input;
  const { mainWorktree } = worktree;
  if (options.resetPorts) refuseWhileRunning(mainWorktree, registryDir);
  if (worktree.isMainWorktree) await ensureMainEntry(mainWorktree, registryDir);
  const workspace = resolveCurrentWorkspace(mainWorktree, registryDir);
  const entry = readWorkspaces(mainWorktree, registryDir).workspaces[workspace.name];
  if (!entry) throw new WorkspaceError(`No workspace "${workspace.name}" in the registry.`);
  checkReady(input, workspace, entry);

  try {
    const ports = await reconcileWorkspacePorts(input, workspace, entry);
    const base: SetupContextBase = {
      name: workspace.name,
      currentWorktree: workspace.worktree,
      mainWorktree,
      isMainWorktree: workspace.main === true,
    };
    await writeRunFiles(input.runFiles, { ...base, ports });
    await runSetupHook(input, { ...base, ports, force: options.force, log: console.log }, entry);
    return { workspace, ports };
  } catch (err) {
    await recordDevSetupFailure(mainWorktree, registryDir, workspace.name, errorMessage(err));
    throw asKernelError(err);
  }
}

function refuseWhileRunning(mainWorktree: string, registryDir: string): void {
  const entry = findOwnEntry(mainWorktree, registryDir, process.cwd());
  if (!entry || !Object.values(entry.pids).some(isProcessAlive)) return;
  throw new WorkspaceError(
    `The dev-server of this worktree is running. Stop it with \`${devCmd("down")}\`, then run ` +
      `\`${devCmd("setup --reset-ports")}\` again.`,
  );
}

/** Re-keys a renamed main entry, or creates a `ready` main entry when there is none. */
async function ensureMainEntry(mainWorktree: string, registryDir: string): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const name = basename(mainWorktree);
    const oldName = rekeyMainEntry(registry, mainWorktree);
    if (oldName !== undefined) warnMainRenamed(oldName, name);
    if (Object.values(registry.workspaces).some((entry) => entry.main === true)) return;
    const taken = registry.workspaces[name];
    if (taken) {
      throw new WorkspaceError(
        `The workspace name "${name}" is already taken by ${taken.worktree}. ` +
          "Worktree directory names must be unique.",
      );
    }
    registry.workspaces[name] = {
      worktree: mainWorktree,
      createdAt: new Date().toISOString(),
      status: "ready",
      main: true,
    };
  });
}

function checkReady(
  input: DevSetupInput,
  workspace: ResolvedWorkspace,
  entry: WorkspaceEntry,
): void {
  const result = buildWorktreeReadyMessage({
    name: workspace.name,
    worktreePath: workspace.worktree,
    runtimeDir: input.runtimeDir,
    entry,
    now: Date.now(),
    pm: packageManagerCommands(),
    acceptPending: input.options.fromFinalize,
  });
  if (result.ok) return;
  console.error(result.message);
  process.exit(1);
}

export type WorktreeReadyCheck = { ok: true } | { ok: false; message: string };

/**
 * Pure builder for the worktree-readiness gate of `dev setup`. Returns `ok` when the workspace is
 * `ready` or absent (synthesized main), or `pending` with `acceptPending`; otherwise returns the
 * user-facing error message.
 */
export function buildWorktreeReadyMessage(input: {
  name: string;
  worktreePath: string;
  runtimeDir: string;
  entry: WorkspaceEntry | undefined;
  now: number;
  pm: PackageManagerCommands;
  acceptPending?: boolean;
}): WorktreeReadyCheck {
  const { name, worktreePath, runtimeDir, entry, now, pm } = input;
  if (!entry || entry.status === "ready") return { ok: true };
  if (entry.status === "pending" && input.acceptPending === true) return { ok: true };
  const ws = pm.workspace.withArgs;
  const logPath = setupLogPath(worktreePath, runtimeDir);
  if (entry.status === "pending") {
    const elapsed = formatDuration(now - Date.parse(entry.createdAt));
    return {
      ok: false,
      message:
        `Error: Worktree setup is still in progress (workspace ${name}, started ${elapsed} ago).\n` +
        `Tail: ${logPath}\n` +
        `Run \`${ws} wait\` to block until it finishes, or retry \`${pm.dev.base}\` once ready.`,
    };
  }
  const failureAt = entry.failure?.at ?? entry.createdAt;
  const elapsed = formatDuration(now - Date.parse(failureAt));
  const reason = entry.failure?.message ?? "(no message)";
  return {
    ok: false,
    message:
      `Error: Worktree setup failed (workspace ${name}, ${elapsed} ago): ${reason}\n` +
      `Tail: ${logPath}\n` +
      `Re-run \`${ws} setup\` to retry the finalize.`,
  };
}

/**
 * Reconciles and stores the workspace's ports under the registry lock; the listen probes run
 * inside it. Without a `ports` group, the stored ports are returned untouched.
 */
async function reconcileWorkspacePorts(
  input: DevSetupInput,
  workspace: ResolvedWorkspace,
  entry: WorkspaceEntry,
): Promise<Record<string, number>> {
  const config = input.ports;
  if (config === undefined) return entry.ports ?? {};
  const { mainWorktree } = input.worktree;
  const { ports, changed } = await updateWorkspaces(
    mainWorktree,
    input.registryDir,
    async (registry) => {
      const current = registry.workspaces[workspace.name];
      if (!current) throw new WorkspaceError(`Workspace "${workspace.name}" left the registry.`);
      const previous = current.ports ?? {};
      const next = await reconcilePorts({
        config,
        isMainWorktree: workspace.main === true,
        stored: input.options.resetPorts ? {} : previous,
        others: portsOfOtherEntries(registry, workspace.name),
        isFree: isPortFree,
      });
      current.ports = next;
      return { ports: next, changed: !samePorts(previous, next) };
    },
  );
  if (changed) console.log(`Ports: ${formatPorts(ports)}`);
  return ports;
}

function portsOfOtherEntries(registry: WorkspacesRegistry, name: string): number[] {
  return Object.entries(registry.workspaces)
    .filter(([other]) => other !== name)
    .flatMap(([, entry]) => Object.values(entry.ports ?? {}));
}

function samePorts(a: Record<string, number>, b: Record<string, number>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

/** Run files are never reseeded: a deleted one is recreated from its source. */
async function writeRunFiles(runFiles: RunFileEntry[], ctx: RunFileContext): Promise<void> {
  await seedFiles({
    entries: runFiles,
    ctx,
    force: false,
    log: { tee: console.log, verbose: noop },
  });
}

function noop(): void {}

/**
 * Runs the hook when the workspace was never set up, or with `--force`, then stores `devSetupAt`.
 * A successful run clears `devSetupFailure`.
 */
async function runSetupHook(
  input: DevSetupInput,
  ctx: DevSetupContext,
  entry: WorkspaceEntry,
): Promise<void> {
  const { setup } = input;
  const runs = setup !== undefined && (entry.devSetupAt === undefined || ctx.force);
  if (runs) await setup(ctx);
  if (!runs && entry.devSetupFailure === undefined) return;
  await updateWorkspaces(input.worktree.mainWorktree, input.registryDir, (registry) => {
    const current = registry.workspaces[ctx.name];
    if (!current) return;
    if (runs) current.devSetupAt = new Date().toISOString();
    delete current.devSetupFailure;
  });
}

async function recordDevSetupFailure(
  mainWorktree: string,
  registryDir: string,
  name: string,
  message: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = registry.workspaces[name];
    if (entry) entry.devSetupFailure = { at: new Date().toISOString(), message };
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A hook's own error becomes a `WorkspaceError`, so the CLI reports it without a stack trace. */
function asKernelError(err: unknown): Error {
  if (err instanceof WorkspaceError || err instanceof ConfigError) return err;
  return new WorkspaceError(`dev setup failed: ${errorMessage(err)}`, { cause: err });
}
