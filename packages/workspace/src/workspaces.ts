import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { loadWorkspaceManifest, resolveConfigFamily, WORKSPACE_CONFIG_FAMILY } from "./config.js";
import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./invocation.js";
import { readRegistry, writeRegistry } from "./registry-storage.js";
import { withRegistryLock } from "./registry-lock.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";
const REGISTRY_VERSION = 3;
const PORTS_SCHEMA = {
  type: "object",
  additionalProperties: { type: "integer", minimum: 1, maximum: 65535 },
};
const FAILURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["at", "message"],
  properties: { at: { type: "string", format: "date-time" }, message: { type: "string" } },
};
const REGISTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "workspaces"],
  properties: {
    version: { const: REGISTRY_VERSION },
    workspaces: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["worktree", "createdAt", "status", "recipe"],
        properties: {
          worktree: { type: "string", pattern: "^/" },
          createdAt: { type: "string", format: "date-time" },
          status: { enum: ["pending", "ready", "failed"] },
          recipe: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "defaults" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "file"],
                properties: {
                  kind: { const: "manifest" },
                  file: { enum: ["alignfirst-workspace.json", "alignfirst-workspace.jsonc"] },
                },
              },
            ],
          },
          failure: FAILURE_SCHEMA,
          cleanupPending: { type: "boolean" },
          main: { type: "boolean" },
          neverFinalized: { type: "boolean" },
          ports: PORTS_SCHEMA,
          devSetupAt: { type: "string", format: "date-time" },
          devSetupFailure: FAILURE_SCHEMA,
          runFilesWrittenWith: {
            type: "object",
            additionalProperties: false,
            required: ["ports", "inputs"],
            properties: {
              ports: PORTS_SCHEMA,
              inputs: {
                type: "object",
                additionalProperties: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
              },
            },
          },
        },
      },
    },
  },
};

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
  /** Destructive workspace cleanup must succeed before any new preparation or startup. */
  cleanupPending?: boolean;
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
  recipe: WorkspaceRecipe;
}

export type WorkspaceRecipe =
  | { kind: "defaults" }
  | { kind: "manifest"; file: "alignfirst-workspace.json" | "alignfirst-workspace.jsonc" };

export type WorkspaceStatus = "pending" | "ready" | "failed";

export interface RunFilesBasis {
  ports: Record<string, number>;
  /** Per-key `sha256:<64 lowercase hex>` of defined UTF-8 values; absent keys stay absent. */
  inputs: Record<string, string>;
}

/** The registry as `workspaces.json` holds it. */
interface StoredRegistry {
  version: 3;
  workspaces: Record<string, WorkspaceEntry>;
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

/** Main relocation is in-memory until the next locked write; linked orphans retain identity. */
export function readWorkspaces(mainWorktree: string, registryDir: string): WorkspacesRegistry {
  return loadWorkspaces(mainWorktree, registryDir).registry;
}

interface LoadedRegistry {
  registry: WorkspacesRegistry;
  originalMainPath?: string;
}

function loadWorkspaces(mainWorktree: string, registryDir: string): LoadedRegistry {
  const filePath = workspacesFilePath(mainWorktree, registryDir);
  const retired = join(mainWorktree, registryDir, "slots.json");
  if (existsSync(retired))
    throw new WorkspaceError(
      `Unsupported retired registry ${retired}. Account for its services and resources before explicitly upgrading state.`,
    );
  const stored = readRegistry<StoredRegistry>(
    filePath,
    REGISTRY_SCHEMA,
    { version: 3, workspaces: {} },
    mainWorktree,
  );
  const workspaces: Record<string, WorkspaceEntry> = Object.create(null);
  let mainCount = 0;
  for (const [name, entry] of Object.entries(stored.workspaces)) {
    if (entry.main === true) ++mainCount;
    workspaces[name] = {
      ...entry,
      worktree: entry.main === true ? resolve(mainWorktree) : resolve(entry.worktree),
    };
  }
  if (
    mainCount > 1 ||
    new Set(Object.values(workspaces).map((entry) => entry.worktree)).size !==
      Object.keys(workspaces).length
  ) {
    throw new WorkspaceError(
      `Invalid registry ${filePath}: duplicate worktree identities. Repair explicitly before mutation.`,
    );
  }
  const main = Object.entries(workspaces).find(([, entry]) => entry.main === true);
  return {
    registry: { workspaces },
    originalMainPath: main === undefined ? undefined : stored.workspaces[main[0]].worktree,
  };
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
  loadWorkspaces(mainWorktree, registryDir);
  writeRegistry(
    workspacesFilePath(mainWorktree, registryDir),
    stored,
    REGISTRY_SCHEMA,
    mainWorktree,
  );
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

/** Resolves the logical family afresh, allowing extension changes but never missing manifests. */
export function workspaceRecipe(worktree: string): WorkspaceRecipe {
  const location = resolveConfigFamily(worktree, WORKSPACE_CONFIG_FAMILY);
  if (!location.exists) return { kind: "defaults" };
  loadWorkspaceManifest(worktree);
  return {
    kind: "manifest",
    file: location.path.endsWith(".jsonc")
      ? "alignfirst-workspace.jsonc"
      : "alignfirst-workspace.json",
  };
}

export function assertWorkspaceRecipe(worktree: string, recipe: WorkspaceRecipe): void {
  if (recipe.kind !== "manifest") return;
  if (workspaceRecipe(worktree).kind === "manifest") return;
  throw new WorkspaceError(
    `Registered manifest recipe is missing in ${worktree}. Restore alignfirst-workspace.json or .jsonc before preparation or cleanup.`,
  );
}

export interface RegisterWorkspaceInput {
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  isMainWorktree: boolean;
  recipe: WorkspaceRecipe;
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
  assertWorkspaceRecipe(worktree, input.recipe);
  return updateWorkspaces(input.mainWorktree, input.registryDir, (registry) => {
    const found = findWorkspaceByPath(registry, worktree);
    const name = found?.name ?? allocateWorkspaceName(registry.workspaces, worktree);
    const existing = found?.entry;
    if (existing) assertWorkspaceRecipe(worktree, existing.recipe);
    assertWorkspaceCleanupComplete(existing);

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
      recipe: input.recipe,
    };
    if (input.isMainWorktree) entry.main = true;
    registry.workspaces[name] = entry;
    return { name, status: entry.status };
  });
}

export function assertWorkspaceCleanupComplete(entry: WorkspaceEntry | undefined): void {
  if (entry?.cleanupPending !== true) return;
  throw new WorkspaceError(
    `Infrastructure cleanup is pending for ${entry.worktree}. Run \`${wsCmd("teardown")} '${entry.worktree.replaceAll("'", "'\\''")}'\` successfully before setup or dev startup.`,
  );
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
  const oldBasename = basename(originalMainPath);
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
  currentWorktree: string,
): ResolvedWorkspace {
  const found = findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), currentWorktree);
  const workspace: ResolvedWorkspace | undefined = found
    ? { name: found.name, worktree: found.entry.worktree, main: found.entry.main }
    : resolve(mainWorktree) === resolve(currentWorktree)
      ? { name: basename(mainWorktree), worktree: resolve(mainWorktree), main: true }
      : undefined;
  if (!workspace) {
    throw new WorkspaceError(`No workspace here. Run \`${wsCmd("setup")}\` first.`);
  }
  return workspace;
}
