import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";
import { withRegistryLock } from "./registry-lock.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";
/** The registry format with on-demand ports. A file without `version` was written by 0.36 or older. */
const REGISTRY_VERSION = 2;

/** The registry: one entry per workspace, keyed by its worktree directory basename. */
export interface WorkspacesRegistry {
  workspaces: Record<string, WorkspaceEntry>;
}

export interface WorkspaceEntry {
  /** Absolute path of the worktree. */
  worktree: string;
  createdAt: string;
  status: WorkspaceStatus;
  failure?: { at: string; message: string };
  /** `true` for the main-worktree entry. Absent on linked entries. */
  main?: boolean;
  /** `true` on a main entry that `dev setup` created before any `workspace setup` finalized it. */
  neverFinalized?: boolean;
  /** One port per declared name, allocated by `dev setup`. */
  ports?: Record<string, number>;
  /** ISO date of the last successful `DevServerConfig.setup`. */
  devSetupAt?: string;
  /** The last `dev setup` failure. Cleared by a successful `dev setup`. */
  devSetupFailure?: { at: string; message: string };
  /** Legacy: the blob an old `finalizeWorkspace` returned. Carried over; new code never sets it. */
  purgeData?: unknown;
}

export type WorkspaceStatus = "pending" | "ready" | "failed";

/** The registry as `workspaces.json` holds it. */
interface StoredRegistry {
  /** Absent on a registry written by 0.36 or older. */
  version?: number;
  workspaces: Record<string, StoredWorkspaceEntry>;
}

interface StoredWorkspaceEntry extends WorkspaceEntry {
  /** Legacy: the port block index of the old port scheme. Dropped at read time. */
  portIndex?: number;
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
 * Reads the registry, repairing each `worktree` in memory: the main entry points to the current
 * main worktree, and a missing linked worktree to its sibling of the same name. The next
 * {@link writeWorkspaces} persists the repair. A legacy `portIndex` is dropped: those workspaces get
 * new ports at their next `dev setup`.
 */
export function readWorkspaces(mainWorktree: string, registryDir: string): WorkspacesRegistry {
  const filePath = workspacesFilePath(mainWorktree, registryDir);
  if (!existsSync(filePath)) return { workspaces: {} };
  const stored = JSON.parse(readFileSync(filePath, "utf-8")) as StoredRegistry;
  const legacy = stored.version === undefined;
  const workspaces: Record<string, WorkspaceEntry> = {};
  for (const [name, entry] of Object.entries(stored.workspaces)) {
    workspaces[name] = loadEntry(name, entry, mainWorktree, legacy);
  }
  dropDuplicateMainEntries(workspaces, mainWorktree);
  return { workspaces };
}

function loadEntry(
  name: string,
  stored: StoredWorkspaceEntry,
  mainWorktree: string,
  legacy: boolean,
): WorkspaceEntry {
  const { portIndex, ...fields } = stored;
  const entry: WorkspaceEntry = { ...fields, worktree: repairWorktree(name, stored, mainWorktree) };
  // The old `finalizeWorkspace` of a ready legacy entry already provisioned its infrastructure.
  if (legacy && entry.status === "ready") entry.devSetupAt ??= entry.createdAt;
  return entry;
}

function repairWorktree(name: string, stored: StoredWorkspaceEntry, mainWorktree: string): string {
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

/**
 * Writes a temporary file next to `workspaces.json`, then renames it over the registry, so a reader
 * that does not take the lock never sees a half-written file.
 */
export function writeWorkspaces(
  mainWorktree: string,
  registryDir: string,
  registry: WorkspacesRegistry,
): void {
  const stored: StoredRegistry = { version: REGISTRY_VERSION, workspaces: registry.workspaces };
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  const filePath = workspacesFilePath(mainWorktree, registryDir);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(stored, undefined, 2)}\n`);
  renameSync(tempPath, filePath);
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

export interface RegisterWorkspaceInput {
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  isMainWorktree: boolean;
  /** When `true`, an existing `ready` workspace is reset to `pending` so the re-finalize is observable. */
  force?: boolean;
}

export interface RegisteredWorkspace {
  name: string;
  status: WorkspaceStatus;
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
      status: isFinalized(existing) && input.force !== true ? "ready" : "pending",
      ports: existing?.ports,
      devSetupAt: existing?.devSetupAt,
      // A `devSetupFailure` is dropped: `workspace wait` reports only this setup's dev failure.
      purgeData: existing?.purgeData,
    };
    if (input.isMainWorktree) entry.main = true;
    registry.workspaces[name] = entry;
    return { name, status: entry.status };
  });
}

function isFinalized(entry: WorkspaceEntry | undefined): boolean {
  return entry?.status === "ready" && entry.neverFinalized !== true;
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
  throw new WorkspaceError(
    `The workspace name "${name}" is already taken by ${existing.worktree}. ` +
      "Worktree directory names must be unique.",
  );
}

export async function markWorkspaceReady(
  mainWorktree: string,
  registryDir: string,
  name: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = registry.workspaces[name];
    if (!entry) return;
    entry.status = "ready";
    delete entry.failure;
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

/** The ports stored on the entry of `worktree`; `{}` when it has none, or no entry. */
export function storedPortsOf(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Record<string, number> {
  const target = resolve(worktree);
  const entry = Object.values(readWorkspaces(mainWorktree, registryDir).workspaces).find(
    (candidate) => resolve(candidate.worktree) === target,
  );
  return entry?.ports ?? {};
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
