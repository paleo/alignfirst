import { randomUUID } from "node:crypto";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import {
  findWorkspaceByPath,
  updateWorkspaces,
  type OwnershipClaim,
  type WorkspaceEntry,
} from "./workspaces.js";

export function createPreparationOwner(): OwnershipClaim {
  return { pid: process.pid, token: randomUUID() };
}

/** Use inside the registration mutation, before preparation can produce effects. */
export function publishPreparationOwner(entry: WorkspaceEntry, owner: OwnershipClaim): void {
  if (entry.cleanupPending === true)
    throw new WorkspaceError(`Cleanup pending for ${entry.worktree}.`);
  if (entry.preparationOwner)
    throw new WorkspaceError(
      `Preparation ownership already exists for ${entry.worktree}; recover it through explicit cleanup.`,
    );
  entry.preparationOwner = owner;
}

/** A detached child must adopt before opening logs or executing hooks. */
export async function adoptPreparationOwner(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  token: string,
): Promise<OwnershipClaim> {
  return updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, worktree)?.entry;
    if (!entry || entry.cleanupPending === true || entry.preparationOwner?.token !== token)
      throw new WorkspaceError(`Preparation ownership lost for ${worktree}.`);
    const owner = { pid: process.pid, token };
    entry.preparationOwner = owner;
    return owner;
  });
}

export async function settlePreparationOwner(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  owner: OwnershipClaim,
  outcome: { status: "ready" } | { status: "failed"; message: string },
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, worktree)?.entry;
    if (
      !entry ||
      entry.cleanupPending === true ||
      owner.pid !== process.pid ||
      entry.preparationOwner?.token !== owner.token ||
      entry.preparationOwner.pid !== owner.pid
    )
      throw new WorkspaceError(`Preparation ownership lost for ${worktree}.`);
    entry.status = outcome.status;
    if (outcome.status === "failed")
      entry.failure = { at: new Date().toISOString(), message: outcome.message };
    else delete entry.failure;
    delete entry.preparationOwner;
  });
}

/** Call in the same locked mutation that establishes the cleanup gate. */
export function recoverPreparationForCleanup(entry: WorkspaceEntry): void {
  if (entry.preparationOwner && isProcessAlive(entry.preparationOwner.pid))
    throw new WorkspaceError(`Preparation still owns ${entry.worktree}.`);
  entry.cleanupPending = true;
  delete entry.preparationOwner;
}
