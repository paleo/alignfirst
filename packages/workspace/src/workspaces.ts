import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";
import type { ResolvedPortsConfig } from "./ports.js";
import { withRegistryLock } from "./registry-lock.js";
import { getWorktreeBranch } from "./worktree.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";

/** The registry: one entry per workspace, keyed by its worktree directory basename. */
export interface WorkspacesRegistry {
  workspaces: Record<string, WorkspaceEntry>;
}

/** The fields an entry stores as they are, on disk and in memory. */
export interface WorkspaceEntryFields {
  createdAt: string;
  status: WorkspaceStatus;
  failure?: { at: string; message: string };
  /** `true` for the main-worktree entry. Absent on linked entries. */
  main?: boolean;
  /** Port block index, stored only for linked workspaces when the config declares `ports`. */
  portIndex?: number;
  /** One port per declared name, allocated by `dev setup`. */
  ports?: Record<string, number>;
  /** ISO date of the last successful `DevServerConfig.setup`. */
  devSetupAt?: string;
  /** The last `dev setup` failure. Cleared by a successful `dev setup`. */
  devSetupFailure?: { at: string; message: string };
  /** Legacy: the blob an old `finalizeWorkspace` returned. Carried over; new code never sets it. */
  purgeData?: unknown;
}

/** An entry in memory, as every reader receives it. */
export interface WorkspaceEntry extends WorkspaceEntryFields {
  /** Absolute path of the worktree. */
  worktree: string;
}

export type WorkspaceStatus = "pending" | "ready" | "failed";

/** The registry as `workspaces.json` holds it. */
interface StoredRegistry {
  workspaces: Record<string, StoredWorkspaceEntry>;
}

interface StoredWorkspaceEntry extends WorkspaceEntryFields {
  /**
   * Relative to the main worktree, with POSIX separators; `"."` for the main worktree. Absolute on
   * a legacy entry, written before relative paths.
   */
  worktree: string;
}

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

export function workspacesFilePath(mainWorktree: string, registryDir: string): string {
  return join(mainWorktree, registryDir, WORKSPACES_FILENAME);
}

/**
 * Reads the registry with absolute `worktree` paths. Legacy entries are repaired in memory only;
 * the next {@link writeWorkspaces} persists the repair.
 */
export function readWorkspaces(mainWorktree: string, registryDir: string): WorkspacesRegistry {
  const filePath = workspacesFilePath(mainWorktree, registryDir);
  if (!existsSync(filePath)) return { workspaces: {} };
  const stored = JSON.parse(readFileSync(filePath, "utf-8")) as StoredRegistry;
  const workspaces: Record<string, WorkspaceEntry> = {};
  for (const [name, entry] of Object.entries(stored.workspaces)) {
    workspaces[name] = loadEntry(name, entry, mainWorktree);
  }
  dropDuplicateMainEntries(workspaces, mainWorktree);
  return { workspaces };
}

function loadEntry(
  name: string,
  stored: StoredWorkspaceEntry,
  mainWorktree: string,
): WorkspaceEntry {
  if (!isAbsolute(stored.worktree)) {
    return { ...stored, worktree: resolve(mainWorktree, stored.worktree) };
  }
  const entry: WorkspaceEntry = {
    ...stored,
    worktree: repairLegacyWorktree(name, stored, mainWorktree),
  };
  // The old `finalizeWorkspace` of a ready legacy entry already provisioned its infrastructure.
  if (entry.status === "ready") entry.devSetupAt ??= entry.createdAt;
  return entry;
}

function repairLegacyWorktree(
  name: string,
  stored: StoredWorkspaceEntry,
  mainWorktree: string,
): string {
  if (stored.main === true) return mainWorktree;
  if (existsSync(stored.worktree)) return stored.worktree;
  // A project moved together with its worktrees.
  const sibling = join(dirname(mainWorktree), name);
  return existsSync(sibling) ? sibling : stored.worktree;
}

/**
 * An old bug left one main entry per name the main directory ever had. Keeps the entry keyed by the
 * current name when it exists, otherwise the newest.
 */
function dropDuplicateMainEntries(
  workspaces: Record<string, WorkspaceEntry>,
  mainWorktree: string,
): void {
  const mains = Object.entries(workspaces).filter(([, entry]) => entry.main === true);
  if (mains.length < 2) return;
  const currentName = basename(mainWorktree);
  const kept =
    workspaces[currentName]?.main === true
      ? currentName
      : mains.reduce((a, b) => (a[1].createdAt >= b[1].createdAt ? a : b))[0];
  for (const [name] of mains) {
    if (name !== kept) delete workspaces[name];
  }
}

export function writeWorkspaces(
  mainWorktree: string,
  registryDir: string,
  registry: WorkspacesRegistry,
): void {
  const stored: StoredRegistry = { workspaces: {} };
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    stored.workspaces[name] = {
      ...entry,
      worktree: toStoredWorktree(mainWorktree, entry.worktree),
    };
  }
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(
    workspacesFilePath(mainWorktree, registryDir),
    `${JSON.stringify(stored, undefined, 2)}\n`,
  );
}

/** The stored form of an absolute worktree path: relative to the main worktree, POSIX separators. */
export function toStoredWorktree(mainWorktree: string, worktree: string): string {
  const rel = relative(mainWorktree, worktree);
  if (rel === "") return ".";
  return rel.split(sep).join(posix.sep);
}

/** Reads, mutates and writes the registry under the registry lock. */
export async function updateWorkspaces<T>(
  mainWorktree: string,
  registryDir: string,
  mutate: (registry: WorkspacesRegistry) => T | Promise<T>,
): Promise<T> {
  return withRegistryLock(mainWorktree, registryDir, async () => {
    const registry = readWorkspaces(mainWorktree, registryDir);
    const result = await mutate(registry);
    writeWorkspaces(mainWorktree, registryDir, registry);
    return result;
  });
}

/** Reads the registry under the registry lock, so a concurrent write is never read half-done. */
export async function readWorkspacesLocked(
  mainWorktree: string,
  registryDir: string,
): Promise<WorkspacesRegistry> {
  return withRegistryLock(mainWorktree, registryDir, () =>
    readWorkspaces(mainWorktree, registryDir),
  );
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

export async function registerWorkspace(
  input: RegisterWorkspaceInput,
): Promise<RegisteredWorkspace> {
  const name = basename(input.currentWorktree);
  return updateWorkspaces(input.mainWorktree, input.registryDir, (registry) => {
    const oldMainName = rekeyMainEntry(registry, input.mainWorktree);
    if (oldMainName !== undefined) warnMainRenamed(oldMainName, basename(input.mainWorktree));
    const existing = registry.workspaces[name];
    refuseNameCollision(name, existing, input.currentWorktree);

    const entry: WorkspaceEntry = {
      worktree: input.currentWorktree,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      // Re-runs of `workspace setup` keep a previously finalized workspace ready, unless `--force`
      // is set — then we reset to pending so `workspace wait` blocks and `dev` refuses during the
      // re-finalize.
      status: existing?.status === "ready" && input.force !== true ? "ready" : "pending",
      ports: existing?.ports,
      devSetupAt: existing?.devSetupAt,
      devSetupFailure: existing?.devSetupFailure,
      purgeData: existing?.purgeData,
    };
    if (input.isMainWorktree) entry.main = true;
    if (input.ports && !input.isMainWorktree) {
      entry.portIndex = existing?.portIndex ?? lowestFreePortIndex(registry, input.ports);
    }
    registry.workspaces[name] = entry;
    return { name, status: entry.status, portIndex: entry.portIndex };
  });
}

/**
 * Moves the main entry (`main: true`) under `basename(mainWorktree)` when the main directory was
 * renamed, and returns the old name. The entry keeps its fields except `devSetupAt`: infrastructure
 * is named after the workspace, so the next `dev setup` provisions it under the new name. Leaves
 * the registry untouched when another entry already holds the new name.
 */
export function rekeyMainEntry(
  registry: WorkspacesRegistry,
  mainWorktree: string,
): string | undefined {
  const newName = basename(mainWorktree);
  const found = Object.entries(registry.workspaces).find(([, entry]) => entry.main === true);
  if (!found || found[0] === newName || registry.workspaces[newName]) return;
  const [oldName, entry] = found;
  delete registry.workspaces[oldName];
  delete entry.devSetupAt;
  registry.workspaces[newName] = entry;
  return oldName;
}

export function warnMainRenamed(oldName: string, newName: string): void {
  console.error(
    `Warning: The main worktree directory was renamed from "${oldName}" to "${newName}". ` +
      `Infrastructure named after "${oldName}" is not reused: rename the directory back to ` +
      "recover it, or remove it by hand.",
  );
}

function refuseNameCollision(
  name: string,
  existing: WorkspaceEntry | undefined,
  currentWorktree: string,
): void {
  if (!existing || resolve(existing.worktree) === resolve(currentWorktree)) return;
  const branch = getWorktreeBranch(existing.worktree) ?? "(detached)";
  throw new WorkspaceError(
    `The workspace name "${name}" is already taken by ${existing.worktree} ` +
      `(branch: ${branch}). Worktree directory names must be unique.`,
  );
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
  throw new WorkspaceError(
    `All ${ports.maxWorkspaces} workspace indexes are taken. ` +
      `Remove a workspace with \`${wsCmd("remove")}\` first.`,
  );
}

export async function markWorkspaceReady(
  mainWorktree: string,
  registryDir: string,
  name: string,
  purgeData?: unknown,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = registry.workspaces[name];
    if (!entry) return;
    entry.status = "ready";
    delete entry.failure;
    if (purgeData !== undefined) entry.purgeData = purgeData;
  });
}

export async function markWorkspaceFailed(
  mainWorktree: string,
  registryDir: string,
  name: string,
  message: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = registry.workspaces[name];
    if (!entry) return;
    entry.status = "failed";
    entry.failure = { at: new Date().toISOString(), message };
  });
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

export function resolveCurrentWorkspace(
  mainWorktree: string,
  registryDir: string,
): ResolvedWorkspace {
  const workspace =
    lookupWorkspaceForCwd(mainWorktree, registryDir) ?? synthesizeMainWorkspace(mainWorktree);
  if (!workspace) {
    console.error(`Error: No workspace here. Run \`${wsCmd("setup")}\` first.`);
    process.exit(1);
  }
  return workspace;
}

function lookupWorkspaceForCwd(
  mainWorktree: string,
  registryDir: string,
): ResolvedWorkspace | undefined {
  const cwd = resolve(process.cwd());
  const registry = readWorkspaces(mainWorktree, registryDir);
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    if (resolve(entry.worktree) !== cwd) continue;
    const resolved: ResolvedWorkspace = { name, worktree: entry.worktree };
    if (entry.main) resolved.main = true;
    return resolved;
  }
}

function synthesizeMainWorkspace(mainWorktree: string): ResolvedWorkspace | undefined {
  const cwd = resolve(process.cwd());
  if (resolve(mainWorktree) !== cwd) return;
  return { name: basename(cwd), worktree: cwd, main: true };
}
