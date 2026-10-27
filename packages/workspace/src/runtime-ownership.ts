import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { readDevServers } from "./dev-servers-registry.js";
import { WorkspaceError } from "./errors.js";
import { canonicalPath } from "./git.js";
import { isProcessAlive } from "./process-control.js";
import { assertDirectoryPath } from "./registry-ownership.js";
import { readStartupOwners, recoverStartupForCleanup } from "./startup-ownership.js";
import { resolveWorkspaceStorage, type WorkspaceStorage } from "./storage.js";
import {
  assertWorkspaceCleanupComplete,
  findWorkspaceByPath,
  readWorkspaces,
  updateWorkspaces,
  type OwnershipClaim,
  type RuntimeOwner,
  type WorkspacesRegistry,
} from "./workspaces.js";

export interface RuntimeDisposal {
  storage: WorkspaceStorage;
  generation: string;
  claim: OwnershipClaim;
}

/** Persist ownership before hooks or log creation. A retained path starts a new generation. */
export async function claimRuntime(storage: WorkspaceStorage): Promise<RuntimeOwner | undefined> {
  assertStorage(storage);
  return updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
    if (storage.in === "project") return;
    assertWorkspaceCleanupComplete(findWorkspaceByPath(registry, storage.currentWorktree)?.entry);
    registry.runtimeOwners ??= {};
    const owners = registry.runtimeOwners;
    const id = basename(storage.runtimeDir);
    const existing = owners[id];
    if (existing?.state === "deletionPending") throw pendingError(storage);
    if (existing?.state === "active") return { ...existing };
    if (existing) assertQuiescent(storage, registry, true);
    else if (
      lstatSync(storage.runtimeDir, { throwIfNoEntry: false }) !== undefined &&
      readdirSync(storage.runtimeDir).length !== 0
    )
      throw new WorkspaceError(
        `Nonempty unowned runtime destination: ${storage.runtimeDir}. Preserve files and recover explicitly.`,
      );
    const owner: RuntimeOwner = {
      worktree: storage.currentWorktree,
      runtimeDir: storage.runtimeDir,
      main: storage.currentWorktree === storage.mainWorktree,
      generation: randomUUID(),
      state: "active",
    };
    owners[id] = owner;
    return { ...owner };
  });
}

/** Validate ownership and log destinations immediately before runtime writes. Creates nothing. */
export function assertRuntimeOwnership(storage: WorkspaceStorage): void {
  assertStorage(storage);
  const registry = readWorkspaces(storage.mainWorktree, storage.registryDir);
  if (storage.in === "companion") {
    const owner = registry.runtimeOwners?.[basename(storage.runtimeDir)];
    if (owner?.state !== "active" || owner.worktree !== storage.currentWorktree)
      throw new WorkspaceError(`Runtime must be claimed before writing ${storage.runtimeDir}.`);
  }
  const root =
    storage.in === "companion" ? resolve(storage.registryDir, "../..") : storage.currentWorktree;
  const logs = resolve(storage.runtimeDir, "logs");
  assertDirectoryPath(root, logs);
  if (lstatSync(logs, { throwIfNoEntry: false }) === undefined) return;
  for (const name of readdirSync(logs)) {
    const path = resolve(logs, name);
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink())
      throw new WorkspaceError(`Conflicting runtime log destination: ${path}.`);
  }
}

/** Successful teardown retains files; remove/prune publish deletionPending without a reuse gap. */
export async function releaseRuntimeResources(
  storage: WorkspaceStorage,
  generation: string,
  mode: "retain" | "delete",
): Promise<void> {
  assertStorage(storage);
  await updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
    const runtime = expectedRuntime(storage, registry, generation);
    if (runtime.state === "deletionPending" && mode === "retain") throw pendingError(storage);
    assertQuiescent(storage, registry, false);
    if (runtime.deletionClaim && isProcessAlive(runtime.deletionClaim.pid))
      throw pendingError(storage);
    const found = findWorkspaceByPath(registry, storage.currentWorktree);
    if (found && found.entry.cleanupPending !== true)
      throw new WorkspaceError(`Cleanup gate missing for ${storage.currentWorktree}.`);
    recoverStartupForCleanup(storage.mainWorktree, storage.registryDir, storage.currentWorktree);
    if (found) delete registry.workspaces[found.name];
    runtime.state = mode === "retain" ? "retained" : "deletionPending";
    delete runtime.deletionClaim;
  });
}

/** Runtime-only cleanup captures this generation before asynchronous work, never after release. */
export function retainedRuntime(storage: WorkspaceStorage): RuntimeOwner | undefined {
  assertStorage(storage);
  const registry = readWorkspaces(storage.mainWorktree, storage.registryDir);
  const runtime = registry.runtimeOwners?.[basename(storage.runtimeDir)];
  if (!runtime) return;
  assertQuiescent(storage, registry, true);
  if (runtime.state === "active")
    throw new WorkspaceError(
      `Runtime still active for ${storage.currentWorktree}. Complete cleanup first.`,
    );
  return { ...runtime };
}

/** No lock is held while the filesystem is recursively removed. Live claims never expire by age. */
export async function claimRuntimeDisposal(
  storage: WorkspaceStorage,
  generation: string,
): Promise<RuntimeDisposal> {
  assertStorage(storage);
  return updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
    const runtime = expectedRuntime(storage, registry, generation);
    assertQuiescent(storage, registry, true);
    if (runtime.state === "active")
      throw new WorkspaceError(`Runtime cleanup has not completed for ${storage.currentWorktree}.`);
    if (runtime.deletionClaim && isProcessAlive(runtime.deletionClaim.pid))
      throw pendingError(storage);
    recoverStartupForCleanup(storage.mainWorktree, storage.registryDir, storage.currentWorktree);
    const claim = { pid: process.pid, token: randomUUID() };
    runtime.state = "deletionPending";
    runtime.deletionClaim = claim;
    return { storage, generation, claim };
  });
}

/** Failure leaves deletionPending and only releases this caller's exclusive claim. */
export async function disposeRuntime(
  disposal: RuntimeDisposal,
  signal?: AbortSignal,
): Promise<void> {
  const { storage, generation } = disposal;
  try {
    signal?.throwIfAborted();
    await updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
      assertDisposal(disposal, registry);
      assertQuiescent(storage, registry, true);
      assertStorage(storage);
    });
    signal?.throwIfAborted();
    assertStorage(storage);
    await rm(storage.runtimeDir, { recursive: true, force: true });
    signal?.throwIfAborted();
    await updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
      assertDisposal(disposal, registry);
      delete registry.runtimeOwners?.[basename(storage.runtimeDir)];
    });
  } catch (error) {
    await updateWorkspaces(storage.mainWorktree, storage.registryDir, (registry) => {
      const runtime = registry.runtimeOwners?.[basename(storage.runtimeDir)];
      if (
        disposal.claim.pid === process.pid &&
        runtime?.generation === generation &&
        runtime.deletionClaim?.token === disposal.claim.token &&
        runtime.deletionClaim.pid === disposal.claim.pid
      )
        delete runtime.deletionClaim;
    });
    throw error;
  }
}

function assertDisposal(disposal: RuntimeDisposal, registry: WorkspacesRegistry): void {
  const runtime = expectedRuntime(disposal.storage, registry, disposal.generation);
  if (
    runtime.state !== "deletionPending" ||
    disposal.claim.pid !== process.pid ||
    runtime.deletionClaim?.token !== disposal.claim.token ||
    runtime.deletionClaim.pid !== disposal.claim.pid
  )
    throw new WorkspaceError(
      `Runtime deletion ownership lost for ${disposal.storage.currentWorktree}.`,
    );
}

function expectedRuntime(
  storage: WorkspaceStorage,
  registry: WorkspacesRegistry,
  generation: string,
): RuntimeOwner {
  const runtime = registry.runtimeOwners?.[basename(storage.runtimeDir)];
  if (
    !runtime ||
    runtime.generation !== generation ||
    runtime.worktree !== storage.currentWorktree ||
    runtime.runtimeDir !== storage.runtimeDir
  )
    throw new WorkspaceError(
      `Runtime generation changed for ${storage.currentWorktree}. Retry cleanup from fresh state.`,
    );
  return runtime;
}

function assertQuiescent(
  storage: WorkspaceStorage,
  registry: WorkspacesRegistry,
  noWorkspace: boolean,
): void {
  const entry = findWorkspaceByPath(registry, storage.currentWorktree)?.entry;
  if (entry?.preparationOwner && isProcessAlive(entry.preparationOwner.pid))
    throw new WorkspaceError(`Live preparation owns ${storage.currentWorktree}.`);
  if (noWorkspace && entry)
    throw new WorkspaceError(`Registered resources still own ${storage.currentWorktree}.`);
  if (
    readStartupOwners(storage.mainWorktree, storage.registryDir).owners.some(
      (owner) => owner.worktree === storage.currentWorktree && isProcessAlive(owner.pid),
    )
  )
    throw new WorkspaceError(`Live startup owns ${storage.currentWorktree}.`);
  if (
    readDevServers(storage.mainWorktree, storage.registryDir).servers.some(
      (server) => server.worktree === storage.currentWorktree,
    )
  )
    throw new WorkspaceError(`Dev resources still own ${storage.currentWorktree}.`);
}

function assertStorage(storage: WorkspaceStorage): void {
  const expected = resolveWorkspaceStorage(storage, storage.currentWorktree);
  if (
    expected.registryDir !== storage.registryDir ||
    expected.runtimeDir !== storage.runtimeDir ||
    expected.currentWorktree !== storage.currentWorktree ||
    expected.mainWorktree !== storage.mainWorktree
  )
    throw new WorkspaceError(
      `Runtime storage identity changed for ${storage.currentWorktree}. Preserve state and recover explicitly.`,
    );
  if (storage.in === "companion") {
    const root = resolve(storage.registryDir, "../..");
    if (root !== canonicalPath(root))
      throw new WorkspaceError(`Runtime storage root moved: ${root}.`);
    assertDirectoryPath(root, storage.runtimeDir);
    if (dirname(storage.runtimeDir) !== resolve(root, ".local-wt/worktrees"))
      throw pendingError(storage);
  }
}

function pendingError(storage: WorkspaceStorage): WorkspaceError {
  return new WorkspaceError(
    `Runtime deletion pending or owned for ${storage.currentWorktree}. Retry explicit removal or prune.`,
  );
}

export interface KnownWorkspaceState {
  requiresCleanup: boolean;
  registeredWorktrees: string[];
  retainedWorktrees: string[];
  deletionPendingWorktrees: string[];
}

/** Data-only admission information for the currently selected registry, never placement history. */
export function inspectKnownWorkspaceState(
  mainWorktree: string,
  registryDir: string,
): KnownWorkspaceState {
  const registry = readWorkspaces(mainWorktree, registryDir);
  const dev = readDevServers(mainWorktree, registryDir);
  const startups = readStartupOwners(mainWorktree, registryDir);
  const runtimes = Object.values(registry.runtimeOwners ?? {});
  const registeredWorktrees = [
    ...new Set([
      ...Object.values(registry.workspaces).map((entry) => entry.worktree),
      ...dev.servers.map((entry) => entry.worktree),
      ...startups.owners
        .filter((owner) => isProcessAlive(owner.pid))
        .map((owner) => owner.worktree),
      ...runtimes
        .filter(
          (owner) =>
            owner.state === "active" ||
            (owner.deletionClaim !== undefined && isProcessAlive(owner.deletionClaim.pid)),
        )
        .map((owner) => owner.worktree),
    ]),
  ];
  const deletionPendingWorktrees = runtimes
    .filter((owner) => owner.state === "deletionPending")
    .map((owner) => owner.worktree);
  return {
    requiresCleanup: registeredWorktrees.length !== 0 || deletionPendingWorktrees.length !== 0,
    registeredWorktrees,
    retainedWorktrees: runtimes
      .filter((owner) => owner.state === "retained")
      .map((owner) => owner.worktree),
    deletionPendingWorktrees,
  };
}
