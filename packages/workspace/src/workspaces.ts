import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./invocation.js";
import { readRegistry, writeRegistry } from "./registry-storage.js";
import { withRegistryLock } from "./registry-lock.js";
import { assertDirectoryPath, registryOwner, type RegistryOwner } from "./registry-ownership.js";
import { canonicalPath } from "./git.js";
import { resolveWorkspaceStorage } from "./storage.js";
import { isProcessAlive } from "./process-control.js";
import { readStartupRegistry } from "./startup-registry.js";

export const REGISTRY_SUBDIR = "workspace-registry";

const WORKSPACES_FILENAME = "workspaces.json";
const REGISTRY_VERSION = 4;
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
const CLAIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pid", "token"],
  properties: { pid: { type: "integer", minimum: 1 }, token: { type: "string", minLength: 1 } },
};
const REGISTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "storage", "workspaces", "runtimeOwners"],
  properties: {
    version: { const: REGISTRY_VERSION },
    storage: {
      type: "object",
      additionalProperties: false,
      required: ["in", "mainWorktree", "registryDir"],
      properties: {
        in: { enum: ["project", "companion"] },
        mainWorktree: { type: "string", pattern: "^/" },
        registryDir: { type: "string", pattern: "^/" },
      },
    },
    runtimeOwners: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["worktree", "runtimeDir", "main", "generation", "state"],
        properties: {
          worktree: { type: "string", pattern: "^/" },
          runtimeDir: { type: "string", pattern: "^/" },
          main: { type: "boolean" },
          generation: { type: "string", minLength: 1 },
          state: { enum: ["active", "retained", "deletionPending"] },
          deletionClaim: CLAIM_SCHEMA,
        },
      },
    },
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
                required: ["kind", "file", "in"],
                properties: {
                  kind: { const: "manifest" },
                  file: { enum: ["alignfirst.json", "alignfirst.jsonc"] },
                  in: { enum: ["project", "companion"] },
                },
              },
            ],
          },
          failure: FAILURE_SCHEMA,
          cleanupPending: { type: "boolean" },
          cleanupOwner: CLAIM_SCHEMA,
          preparationOwner: CLAIM_SCHEMA,
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
  storage?: RegistryOwner;
  runtimeOwners?: Record<string, RuntimeOwner>;
}

export interface RuntimeOwner {
  worktree: string;
  runtimeDir: string;
  main: boolean;
  generation: string;
  state: "active" | "retained" | "deletionPending";
  deletionClaim?: OwnershipClaim;
}

export interface OwnershipClaim {
  pid: number;
  token: string;
}

export interface WorkspaceEntry {
  /** Absolute path of the worktree. */
  worktree: string;
  createdAt: string;
  status: WorkspaceStatus;
  failure?: { at: string; message: string };
  /** Destructive workspace cleanup must succeed before any new preparation or startup. */
  cleanupPending?: boolean;
  /** Exclusive stop/purge owner. An abandoned claim requires explicit subprocess-safe recovery. */
  cleanupOwner?: OwnershipClaim;
  preparationOwner?: OwnershipClaim;
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
  | { kind: "manifest"; file: "alignfirst.json" | "alignfirst.jsonc"; in: "project" | "companion" };

export type WorkspaceStatus = "pending" | "ready" | "failed";

export interface RunFilesBasis {
  ports: Record<string, number>;
  /** Per-key `sha256:<64 lowercase hex>` of defined UTF-8 values; absent keys stay absent. */
  inputs: Record<string, string>;
}

/** The registry as `workspaces.json` holds it. */
export interface StoredRegistry {
  version: 4;
  storage: RegistryOwner;
  workspaces: Record<string, WorkspaceEntry>;
  runtimeOwners: Record<string, RuntimeOwner>;
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
  return resolve(mainWorktree, registryDir, WORKSPACES_FILENAME);
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
  const retired = resolve(mainWorktree, registryDir, "slots.json");
  if (existsSync(retired))
    throw new WorkspaceError(
      `Unsupported retired registry ${retired}. Account for its services and resources before explicitly upgrading state.`,
    );
  const stored = readRegistry<StoredRegistry>(
    filePath,
    REGISTRY_SCHEMA,
    {
      version: 4,
      storage: registryOwner(mainWorktree, registryDir),
      workspaces: {},
      runtimeOwners: {},
    },
    mainWorktree,
  );
  validateRuntimeOwners(stored, filePath);
  const workspaces: Record<string, WorkspaceEntry> = Object.create(null);
  let mainCount = 0;
  for (const [name, entry] of Object.entries(stored.workspaces)) {
    if (entry.main === true) ++mainCount;
    workspaces[name] = {
      ...entry,
      worktree:
        entry.main === true && stored.storage.in === "project"
          ? canonicalPath(mainWorktree)
          : canonicalPath(entry.worktree),
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
    registry: {
      workspaces,
      storage: registryOwner(mainWorktree, registryDir),
      runtimeOwners: stored.runtimeOwners,
    },
    originalMainPath: main === undefined ? undefined : stored.workspaces[main[0]].worktree,
  };
}

function validateRuntimeOwners(stored: StoredRegistry, path: string): void {
  const owner = stored.storage;
  const fail = () => {
    throw new WorkspaceError(
      `Invalid registry ${path}: conflicting runtime ownership. Preserve state and account for resources before explicit recovery.`,
    );
  };
  if (owner.in === "project" && Object.keys(stored.runtimeOwners).length !== 0) fail();
  const targets = new Set<string>();
  const destinations = new Set<string>();
  for (const [id, runtime] of Object.entries(stored.runtimeOwners)) {
    const expected = resolveWorkspaceStorage(
      {
        in: "companion",
        mainWorktree: owner.mainWorktree,
        companionDir: resolve(owner.registryDir, "../.."),
      },
      runtime.worktree,
    );
    if (
      runtime.worktree !== canonicalPath(runtime.worktree) ||
      runtime.runtimeDir !== expected.runtimeDir ||
      basename(expected.runtimeDir) !== id ||
      runtime.main !== (runtime.worktree === owner.mainWorktree) ||
      targets.has(runtime.worktree) ||
      destinations.has(runtime.runtimeDir) ||
      (runtime.deletionClaim !== undefined && runtime.state !== "deletionPending")
    )
      fail();
    assertDirectoryPath(resolve(owner.registryDir, "../.."), runtime.runtimeDir);
    targets.add(runtime.worktree);
    destinations.add(runtime.runtimeDir);
  }
  const workspacePaths = new Set<string>();
  let mainCount = 0;
  for (const entry of Object.values(stored.workspaces)) {
    if (entry.worktree !== canonicalPath(entry.worktree))
      throw new WorkspaceError(
        `Invalid registry ${path}: noncanonical worktree identity. Preserve state and recover explicitly.`,
      );
    if (entry.main === true) ++mainCount;
    if (workspacePaths.has(canonicalPath(entry.worktree)) || mainCount > 1)
      throw new WorkspaceError(
        `Invalid registry ${path}: duplicate worktree identities. Repair explicitly before mutation.`,
      );
    workspacePaths.add(canonicalPath(entry.worktree));
    if (owner.in === "companion" && entry.main === true && entry.worktree !== owner.mainWorktree)
      fail();
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
  const previous = loadWorkspaces(mainWorktree, registryDir).registry;
  const stored: StoredRegistry = {
    version: REGISTRY_VERSION,
    storage: registryOwner(mainWorktree, registryDir),
    workspaces: registry.workspaces,
    runtimeOwners: registry.runtimeOwners ?? previous.runtimeOwners ?? {},
  };
  validateRuntimeOwners(stored, workspacesFilePath(mainWorktree, registryDir));
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
    if (registry.storage?.in === "project")
      reconcileMainIdentity(registry, mainWorktree, originalMainPath);
    const result = await mutate(registry);
    writeWorkspaces(mainWorktree, registryDir, registry);
    return result;
  });
}

/** Compare validated host selections; extension changes retain the same logical source. */
export function assertWorkspaceRecipe(
  worktree: string,
  registered: WorkspaceRecipe,
  selected: WorkspaceRecipe,
): void {
  if (registered.kind === "defaults") return;
  if (selected.kind === "manifest" && registered.in === selected.in) return;
  throw new WorkspaceError(
    `Registered manifest recipe is missing or its source changed in ${worktree}. Restore the selected alignfirst.json or .jsonc source before preparation or cleanup.`,
  );
}

export interface RegisterWorkspaceInput {
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  isMainWorktree: boolean;
  recipe: WorkspaceRecipe;
  preparationOwner?: OwnershipClaim;
  /** Runs under the shared lock before publication; no hooks or nested locks. */
  admit?: (registry: WorkspacesRegistry) => void;
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
  const worktree = canonicalPath(input.currentWorktree);
  return updateWorkspaces(input.mainWorktree, input.registryDir, (registry) => {
    const found = findWorkspaceByPath(registry, worktree);
    const name = found?.name ?? allocateWorkspaceName(registry.workspaces, worktree);
    const existing = found?.entry;
    if (existing) assertWorkspaceRecipe(worktree, existing.recipe, input.recipe);
    assertWorkspaceCleanupComplete(existing);
    assertRuntimeAvailable(registry, worktree);
    if (
      readStartupRegistry(input.mainWorktree, input.registryDir).owners.some(
        (owner) => owner.worktree === worktree,
      )
    )
      throw new WorkspaceError(
        `Startup ownership exists for ${worktree}; finish it or recover through explicit cleanup.`,
      );
    if (existing?.preparationOwner) {
      const reason = isProcessAlive(existing.preparationOwner.pid)
        ? "already in progress"
        : "abandoned; complete explicit cleanup before setup";
      throw new WorkspaceError(`Preparation ${reason} for ${worktree}.`);
    }

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
      preparationOwner: input.preparationOwner,
    };
    if (input.isMainWorktree) entry.main = true;
    input.admit?.(registry);
    registry.workspaces[name] = entry;
    return { name, status: entry.status };
  });
}

export function assertRuntimeAvailable(registry: WorkspacesRegistry, worktree: string): void {
  const runtime = Object.values(registry.runtimeOwners ?? {}).find(
    (owner) => owner.worktree === canonicalPath(worktree),
  );
  if (runtime?.state === "deletionPending")
    throw new WorkspaceError(
      `Runtime deletion pending for ${worktree}. Retry explicit removal or prune before setup/start.`,
    );
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
  const target = canonicalPath(worktree);
  const found = Object.entries(registry.workspaces).find(
    ([, entry]) => canonicalPath(entry.worktree) === target,
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
    if (entry.preparationOwner)
      throw new WorkspaceError(`Preparation owner must settle ${worktree}.`);
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
    if (entry.preparationOwner)
      throw new WorkspaceError(`Preparation owner must settle ${worktree}.`);
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
