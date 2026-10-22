import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { wsCmd } from "./package-manager.js";
import { withRegistryLock } from "./registry-lock.js";
import { detectWorktree } from "./worktree.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";
/** The registry format with on-demand ports. A file without `version` was written by 0.36 or older. */
const REGISTRY_VERSION = 2;

/** One entry per normalized worktree path, keyed by its opaque registered workspace name. */
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
  /** What the run files were last written with. A start rewrites them when it changed. */
  runFilesWrittenWith?: RunFilesBasis;
  /** ISO date of the last successful `DevServerConfig.setup`. */
  devSetupAt?: string;
  /** The last `dev setup` failure. Cleared by a successful `dev setup`. */
  devSetupFailure?: { at: string; message: string };
  /** Legacy: the blob an old `finalizeWorkspace` returned. Carried over; new code never sets it. */
  purgeData?: unknown;
}

export type WorkspaceStatus = "pending" | "ready" | "failed";

export interface RunFilesBasis {
  ports: Record<string, number>;
  /** The defined values of `DevServerConfig.runFilesInputs`. */
  inputs: Record<string, string>;
}

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
  /** Registered workspace name; it may differ from the directory basename. */
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
 * Reads the registry, repairing each `worktree` in memory into an absolute path: the main entry
 * points to the current main worktree, a relative path is resolved against the main worktree, and
 * missing linked paths remain orphans. The next locked update persists the repair.
 * A legacy `portIndex` is dropped: those workspaces get
 * new ports at their next `dev setup`.
 */
export function readWorkspaces(mainWorktree: string, registryDir: string): WorkspacesRegistry {
  return loadWorkspaces(mainWorktree, registryDir).registry;
}

interface LoadedRegistry {
  registry: WorkspacesRegistry;
  originalMainPath?: string;
}

function loadWorkspaces(mainWorktree: string, registryDir: string): LoadedRegistry {
  const filePath = workspacesFilePath(mainWorktree, registryDir);
  if (!existsSync(filePath)) return { registry: { workspaces: {} } };
  const stored = JSON.parse(readFileSync(filePath, "utf-8")) as StoredRegistry;
  const legacy = stored.version === undefined;
  const workspaces: Record<string, WorkspaceEntry> = {};
  for (const [name, entry] of Object.entries(stored.workspaces)) {
    workspaces[name] = loadEntry(entry, mainWorktree, legacy);
  }
  dropDuplicateMainEntries(workspaces, mainWorktree);
  const main = Object.entries(workspaces).find(([, entry]) => entry.main === true);
  return {
    registry: { workspaces },
    originalMainPath: main === undefined ? undefined : stored.workspaces[main[0]].worktree,
  };
}

function loadEntry(
  stored: StoredWorkspaceEntry,
  mainWorktree: string,
  legacy: boolean,
): WorkspaceEntry {
  const { portIndex, ...fields } = stored;
  const entry: WorkspaceEntry = { ...fields, worktree: repairWorktree(stored, mainWorktree) };
  // The old `finalizeWorkspace` of a ready legacy entry already provisioned its infrastructure.
  if (legacy && entry.status === "ready") entry.devSetupAt ??= entry.createdAt;
  return entry;
}

function repairWorktree(stored: StoredWorkspaceEntry, mainWorktree: string): string {
  if (stored.main === true) return resolve(mainWorktree);
  // Missing paths remain orphans: a same-named directory need not belong to this repository.
  return resolve(mainWorktree, stored.worktree);
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
    const { registry, originalMainPath } = loadWorkspaces(mainWorktree, registryDir);
    reconcileMainIdentity(registry, mainWorktree, originalMainPath);
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
  const worktree = resolve(input.currentWorktree);
  return updateWorkspaces(input.mainWorktree, input.registryDir, (registry) => {
    const found = findWorkspaceByPath(registry, worktree);
    const name = found?.name ?? allocateWorkspaceName(registry.workspaces, worktree);
    const existing = found?.entry;

    const entry: WorkspaceEntry = {
      worktree,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      // Re-runs of `workspace setup` keep a previously finalized workspace ready, unless `--force`
      // is set — then we reset to pending so `workspace wait` blocks and `dev` refuses during the
      // re-finalize.
      status: isFinalized(existing) && input.force !== true ? "ready" : "pending",
      ports: existing?.ports,
      runFilesWrittenWith: existing?.runFilesWrittenWith,
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

/** Reconciles before a locked writer can persist repaired paths and discard rename evidence. */
function reconcileMainIdentity(
  registry: WorkspacesRegistry,
  mainWorktree: string,
  originalMainPath: string | undefined,
): void {
  const found = Object.entries(registry.workspaces).find(([, entry]) => entry.main === true);
  if (!found || originalMainPath === undefined) return;
  const [oldName, entry] = found;
  const oldBasename = isAbsolute(originalMainPath) ? basename(originalMainPath) : oldName;
  if (oldBasename === basename(mainWorktree)) return;
  delete registry.workspaces[oldName];
  const newName = allocateWorkspaceName(registry.workspaces, mainWorktree);
  if (newName !== oldName) {
    delete entry.devSetupAt;
    delete entry.runFilesWrittenWith;
    warnMainRenamed(oldName, newName);
  }
  registry.workspaces[newName] = entry;
}

function warnMainRenamed(oldName: string, newName: string): void {
  console.error(
    `Warning: The main worktree directory was renamed from "${oldName}" to "${newName}". ` +
      `Infrastructure named after "${oldName}" is not reused: rename the directory back to ` +
      "recover it, or remove it by hand.",
  );
}

export interface WorkspacePathMatch {
  name: string;
  entry: WorkspaceEntry;
}

/** Exact normalized path lookup; names are never interpreted as directory basenames. */
export function findWorkspaceByPath(
  registry: WorkspacesRegistry,
  worktree: string,
): WorkspacePathMatch | undefined {
  const target = resolve(worktree);
  const found = Object.entries(registry.workspaces).find(
    ([, entry]) => resolve(entry.worktree) === target,
  );
  if (found) return { name: found[0], entry: found[1] };
}

/** Pure allocation; callers insert under the same registry lock. Existing names stay stable. */
export function allocateWorkspaceName(
  workspaces: Record<string, { worktree: string }>,
  worktree: string,
): string {
  const target = resolve(worktree);
  const existing = Object.entries(workspaces).find(
    ([, entry]) => resolve(entry.worktree) === target,
  );
  if (existing) return existing[0];
  const base = basename(target);
  if (!Object.hasOwn(workspaces, base)) return base;
  const digest = createHash("sha256").update(target).digest("hex");
  for (let length = 8; length <= digest.length; ++length) {
    const candidate = `${base}-${digest.slice(0, length)}`;
    if (!Object.hasOwn(workspaces, candidate)) return candidate;
  }
  for (let discriminator = 2; ; ++discriminator) {
    const candidate = `${base}-${digest}-${discriminator}`;
    if (!Object.hasOwn(workspaces, candidate)) return candidate;
  }
}

export async function markWorkspaceReady(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<void> {
  const target = resolve(worktree);
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, target)?.entry;
    if (!entry) return;
    entry.status = "ready";
    delete entry.failure;
  });
}

export async function markWorkspaceFailed(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  message: string,
): Promise<void> {
  const target = resolve(worktree);
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, target)?.entry;
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
  return (
    findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), worktree)?.entry.ports ?? {}
  );
}

export function resolveCurrentWorkspace(
  mainWorktree: string,
  registryDir: string,
  currentWorktree: string = detectWorktree().currentWorktree,
): ResolvedWorkspace {
  const found = findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), currentWorktree);
  const workspace: ResolvedWorkspace | undefined = found
    ? { name: found.name, worktree: found.entry.worktree, main: found.entry.main }
    : resolve(mainWorktree) === resolve(currentWorktree)
      ? { name: basename(mainWorktree), worktree: resolve(mainWorktree), main: true }
      : undefined;
  if (!workspace) {
    console.error(`Error: No workspace here. Run \`${wsCmd("setup")}\` first.`);
    process.exit(1);
  }
  return workspace;
}
