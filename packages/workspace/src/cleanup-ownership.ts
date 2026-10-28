import { randomUUID } from "node:crypto";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import {
  findWorkspaceByPath,
  updateWorkspaces,
  type OwnershipClaim,
  type WorkspaceEntry,
  type WorkspaceRecipe,
  type WorkspacesRegistry,
} from "./workspaces.js";

/** Captured under the shared lock before stop or purge can affect this registration. */
export interface CleanupOwnership {
  /** Registered resource name, which must still identify this exact entry at settlement. */
  name: string;
  /** Absolute target path; missing checkouts retain their cleanup identity. */
  worktree: string;
  /** Registration timestamp captured to reject a later registration at the same path. */
  createdAt: string;
  /** Recipe provenance captured before effects; cleanup cannot silently change its source. */
  recipe: WorkspaceRecipe;
  /** This cleaner's PID/token, held across stop, purge and matching settlement. */
  owner: OwnershipClaim;
  /** Companion runtime generation captured before effects; absent for project-local storage. */
  runtimeGeneration?: string;
}

/** Caller holds the existing registry lock and checks preparation/startup admission. */
export function claimCleanupOwnership(
  registry: WorkspacesRegistry,
  worktree: string,
): CleanupOwnership {
  const found = findWorkspaceByPath(registry, worktree);
  if (!found) throw new WorkspaceError(`Missing cleanup identity for ${worktree}.`);
  const { entry, name } = found;
  if (entry.cleanupOwner) {
    if (isProcessAlive(entry.cleanupOwner.pid))
      throw new WorkspaceError(`Workspace cleanup already in progress for ${worktree}.`);
    throw new WorkspaceError(
      `Abandoned cleanup for ${worktree} requires explicit recovery. ` +
        "Quiesce callers sharing the selected runtime registry and all surviving cleanup " +
        "subprocesses before clearing only this entry's cleanupOwner in workspaces.json. " +
        "Preserve cleanupPending, resource identity, ports and runtime generation, then retry cleanup.",
    );
  }
  const owner = { pid: process.pid, token: randomUUID() };
  entry.cleanupPending = true;
  entry.cleanupOwner = owner;
  return {
    name,
    worktree: entry.worktree,
    createdAt: entry.createdAt,
    recipe: { ...entry.recipe },
    owner,
    runtimeGeneration: Object.values(registry.runtimeOwners ?? {}).find(
      (runtime) => runtime.worktree === entry.worktree,
    )?.generation,
  };
}

/** Every resource-release mutation checks the captured registration on its fresh locked read. */
export function assertCleanupOwnership(
  registry: WorkspacesRegistry,
  cleanup: CleanupOwnership,
): WorkspaceEntry {
  const entry = matchingCleanupEntry(registry, cleanup);
  if (!entry) throw new WorkspaceError(`Cleanup ownership lost for ${cleanup.worktree}.`);
  return entry;
}

function matchingCleanupEntry(
  registry: WorkspacesRegistry,
  cleanup: CleanupOwnership,
): WorkspaceEntry | undefined {
  const found = findWorkspaceByPath(registry, cleanup.worktree);
  if (
    !found ||
    found.name !== cleanup.name ||
    found.entry.createdAt !== cleanup.createdAt ||
    found.entry.cleanupPending !== true ||
    cleanup.owner.pid !== process.pid ||
    found.entry.cleanupOwner?.pid !== cleanup.owner.pid ||
    found.entry.cleanupOwner.token !== cleanup.owner.token ||
    !sameRecipe(found.entry.recipe, cleanup.recipe)
  )
    return;
  const generation = Object.values(registry.runtimeOwners ?? {}).find(
    (runtime) => runtime.worktree === cleanup.worktree,
  )?.generation;
  if (generation !== cleanup.runtimeGeneration) return;
  return found.entry;
}

function sameRecipe(current: WorkspaceRecipe, captured: WorkspaceRecipe): boolean {
  if (current.kind === "defaults") return captured.kind === "defaults";
  return (
    captured.kind === "manifest" && current.in === captured.in && current.file === captured.file
  );
}

/** Failure keeps the admission gate and retry evidence, releasing only this caller's claim. */
export async function releaseCleanupOwnership(
  mainWorktree: string,
  registryDir: string,
  cleanup: CleanupOwnership,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = matchingCleanupEntry(registry, cleanup);
    if (entry) delete entry.cleanupOwner;
  });
}
