import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { wsCmd } from "./package-manager.js";
import type { ResolvedPortsConfig } from "./ports.js";
import { getWorktreeBranch } from "./worktree.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";

/** The registry: one entry per workspace, keyed by its worktree directory basename. */
export interface WorkspacesRegistry {
  workspaces: Record<string, WorkspaceEntry>;
}

export interface WorkspaceEntry {
  worktree: string;
  createdAt: string;
  status: WorkspaceStatus;
  failure?: { at: string; message: string };
  /** `true` for the main-worktree entry. Absent on linked entries. */
  main?: boolean;
  /** Port block index, stored only for linked workspaces when the config declares `ports`. */
  portIndex?: number;
  /** Opaque blob the consumer returns from `finalizeWorktree`, handed back to `purgeInfrastructure`
   * so an orphan's infrastructure can be torn down by name after its worktree (and config) is gone. */
  extra?: unknown;
}

export type WorkspaceStatus = "pending" | "ready" | "failed";

/** The workspace a command acts on, resolved from the cwd. */
export interface ResolvedWorkspace {
  name: string;
  worktree: string;
  /** `true` when this workspace is the main worktree. */
  main?: boolean;
}

export function registryDirFor(runtimeDir: string): string {
  return join(runtimeDir, REGISTRY_SUBDIR);
}

export function readWorkspaces(mainWorktree: string, registryDir: string): WorkspacesRegistry {
  const filePath = join(mainWorktree, registryDir, WORKSPACES_FILENAME);
  if (!existsSync(filePath)) return { workspaces: {} };
  return JSON.parse(readFileSync(filePath, "utf-8")) as WorkspacesRegistry;
}

export function writeWorkspaces(
  mainWorktree: string,
  registryDir: string,
  registry: WorkspacesRegistry,
): void {
  const filePath = join(mainWorktree, registryDir, WORKSPACES_FILENAME);
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(registry, undefined, 2)}\n`);
}

export interface RegisterWorkspaceInput {
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  isMainWorktree: boolean;
  /** Resolved port scheme. Omit in portless mode: no port index is allocated. */
  ports?: ResolvedPortsConfig;
  /** When `true`, an existing `ready` workspace is reset to `pending` so the re-finalize is observable. */
  force?: boolean;
}

export interface RegisteredWorkspace {
  name: string;
  status: WorkspaceStatus;
  /** Present only when `ports` was passed. `undefined` for the main worktree, whose index is 0. */
  portIndex?: number;
}

export function registerWorkspace(input: RegisterWorkspaceInput): RegisteredWorkspace {
  const registry = readWorkspaces(input.mainWorktree, input.registryDir);
  const name = basename(input.currentWorktree);
  const existing = registry.workspaces[name];
  refuseNameCollision(name, existing, input.currentWorktree);

  const entry: WorkspaceEntry = {
    worktree: input.currentWorktree,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    // Re-runs of `workspace setup` keep a previously finalized workspace ready, unless `--force` is
    // set — then we reset to pending so `workspace wait` blocks and `dev` refuses during the
    // re-finalize.
    status: existing?.status === "ready" && input.force !== true ? "ready" : "pending",
  };
  if (input.isMainWorktree) entry.main = true;
  if (input.ports && !input.isMainWorktree) {
    entry.portIndex = existing?.portIndex ?? lowestFreePortIndex(registry, input.ports);
  }
  if (existing?.extra !== undefined) entry.extra = existing.extra;
  registry.workspaces[name] = entry;
  writeWorkspaces(input.mainWorktree, input.registryDir, registry);
  return { name, status: entry.status, portIndex: entry.portIndex };
}

function refuseNameCollision(
  name: string,
  existing: WorkspaceEntry | undefined,
  currentWorktree: string,
): void {
  if (!existing || resolve(existing.worktree) === resolve(currentWorktree)) return;
  const branch = getWorktreeBranch(existing.worktree) ?? "(detached)";
  console.error(
    `Error: The workspace name "${name}" is already taken by ${existing.worktree} ` +
      `(branch: ${branch}). Worktree directory names must be unique.`,
  );
  process.exit(1);
}

function lowestFreePortIndex(registry: WorkspacesRegistry, ports: ResolvedPortsConfig): number {
  const taken = new Set(
    Object.values(registry.workspaces)
      .map((entry) => entry.portIndex)
      .filter((index) => index !== undefined),
  );
  for (let index = 1; index < ports.maxWorkspaces; ++index) {
    if (!taken.has(index)) return index;
  }
  console.error(
    `Error: All ${ports.maxWorkspaces} port blocks are taken. ` +
      `Remove a workspace with \`${wsCmd("remove")}\` first.`,
  );
  process.exit(1);
}

export function markWorkspaceReady(
  mainWorktree: string,
  registryDir: string,
  name: string,
  extra?: unknown,
): void {
  const registry = readWorkspaces(mainWorktree, registryDir);
  const entry = registry.workspaces[name];
  if (!entry) return;
  entry.status = "ready";
  delete entry.failure;
  if (extra !== undefined) entry.extra = extra;
  writeWorkspaces(mainWorktree, registryDir, registry);
}

export function markWorkspaceFailed(
  mainWorktree: string,
  registryDir: string,
  name: string,
  message: string,
): void {
  const registry = readWorkspaces(mainWorktree, registryDir);
  const entry = registry.workspaces[name];
  if (!entry) return;
  entry.status = "failed";
  entry.failure = { at: new Date().toISOString(), message };
  writeWorkspaces(mainWorktree, registryDir, registry);
}

/**
 * The entry's port block index: `0` for the main worktree. `undefined` marks a **stale** entry —
 * registered while the config was portless, so no index was ever allocated.
 */
export function indexOfEntry(entry: WorkspaceEntry): number | undefined {
  return entry.main === true ? 0 : entry.portIndex;
}

export function staleWorkspaceMessage(name: string, worktree: string): string {
  return (
    `Workspace "${name}" was registered without ports. ` +
    `Run \`${wsCmd("setup --force")}\` in ${worktree} to allocate its ports.`
  );
}

export function resolveCurrentWorkspace(registryDir: string): ResolvedWorkspace {
  const workspace = lookupWorkspaceForCwd(registryDir) ?? synthesizeMainWorkspace();
  if (!workspace) {
    console.error(`Error: No workspace here. Run \`${wsCmd("setup")}\` first.`);
    process.exit(1);
  }
  return workspace;
}

function lookupWorkspaceForCwd(registryDir: string): ResolvedWorkspace | undefined {
  const cwd = resolve(process.cwd());
  // Reads workspaces.json relative to cwd's registry symlink (so works in linked worktrees too).
  const filePath = join(registryDir, WORKSPACES_FILENAME);
  if (!existsSync(filePath)) return undefined;
  const registry = JSON.parse(readFileSync(filePath, "utf-8")) as WorkspacesRegistry;
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    if (resolve(entry.worktree) !== cwd) continue;
    const resolved: ResolvedWorkspace = { name, worktree: entry.worktree };
    if (entry.main) resolved.main = true;
    return resolved;
  }
  return undefined;
}

function synthesizeMainWorkspace(): ResolvedWorkspace | undefined {
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf-8" },
  ).trim();
  const mainWorktree = dirname(gitCommonDir);
  const cwd = resolve(process.cwd());
  if (resolve(mainWorktree) !== cwd) return undefined;
  return { name: basename(cwd), worktree: cwd, main: true };
}
