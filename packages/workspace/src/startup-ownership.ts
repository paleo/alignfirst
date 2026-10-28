import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import { withRegistryLock } from "./registry-lock.js";
import {
  readStartupRegistry,
  writeStartupRegistry,
  type StartupOwner,
  type StartupOwners,
} from "./startup-registry.js";
import {
  assertRuntimeAvailable,
  assertWorkspaceCleanupComplete,
  findWorkspaceByPath,
  readWorkspaces,
  type WorkspacesRegistry,
} from "./workspaces.js";

/** The claim survives hooks without holding the registry lock. Only a dead PID is abandoned. */
export async function claimStartup(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  admit?: () => void,
): Promise<StartupOwner> {
  return withRegistryLock(mainWorktree, registryDir, () => {
    admit?.();
    const data = readStartupOwners(mainWorktree, registryDir);
    const path = resolve(worktree);
    const registry = readWorkspaces(mainWorktree, registryDir);
    assertRuntimeAvailable(registry, path);
    const entry = findWorkspaceByPath(registry, path)?.entry;
    assertWorkspaceCleanupComplete(entry);
    if (entry?.preparationOwner)
      throw new WorkspaceError(
        `Preparation still owns ${path}; complete it or recover through explicit cleanup.`,
      );
    const existing = data.owners.find((owner) => owner.worktree === path);
    if (existing && isProcessAlive(existing.pid)) {
      throw new WorkspaceError(`Dev-server startup already in progress for ${path}.`);
    }
    const owner: StartupOwner = { worktree: path, id: randomUUID(), pid: process.pid };
    data.owners = data.owners.filter((entry) => entry.worktree !== path);
    data.owners.push(owner);
    writeStartupRegistry(mainWorktree, registryDir, data);
    return owner;
  });
}

/** Call inside a registry mutation to guard publication or rollback against a replaced owner. */
export function assertStartupOwner(
  mainWorktree: string,
  registryDir: string,
  owner: StartupOwner,
): void {
  const current = readStartupOwners(mainWorktree, registryDir).owners.find(
    (entry) => entry.worktree === owner.worktree,
  );
  if (current?.id !== owner.id || current.pid !== owner.pid || owner.pid !== process.pid) {
    throw new WorkspaceError(`Dev-server startup ownership lost for ${owner.worktree}.`);
  }
}

export async function releaseStartup(
  mainWorktree: string,
  registryDir: string,
  owner: StartupOwner,
): Promise<void> {
  if (owner.pid !== process.pid) return;
  await withRegistryLock(mainWorktree, registryDir, () => {
    const data = readStartupOwners(mainWorktree, registryDir);
    data.owners = data.owners.filter(
      (entry) =>
        entry.worktree !== owner.worktree || entry.id !== owner.id || entry.pid !== owner.pid,
    );
    writeStartupRegistry(mainWorktree, registryDir, data);
  });
}

export function readStartupOwners(mainWorktree: string, registryDir: string): StartupOwners {
  readWorkspaces(mainWorktree, registryDir);
  return readStartupRegistry(mainWorktree, registryDir);
}

/** Call under the shared lock after establishing a workspace cleanup gate. */
export function recoverStartupForCleanup(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  gatedRegistry?: WorkspacesRegistry,
): void {
  const data = readStartupOwners(mainWorktree, registryDir);
  const owner = data.owners.find((entry) => entry.worktree === resolve(worktree));
  if (!owner) return;
  if (isProcessAlive(owner.pid)) throw new WorkspaceError(`Live startup owns ${worktree}.`);
  const registry = gatedRegistry ?? readWorkspaces(mainWorktree, registryDir);
  const entry = findWorkspaceByPath(registry, worktree)?.entry;
  const runtime = Object.values(registry.runtimeOwners ?? {}).find(
    (record) => record.worktree === resolve(worktree),
  );
  if (
    entry?.cleanupPending !== true &&
    runtime?.state !== "deletionPending" &&
    runtime?.state !== "retained"
  )
    throw new WorkspaceError(
      `Persist a cleanup gate before recovering startup ownership for ${worktree}.`,
    );
  data.owners = data.owners.filter((entry) => entry.worktree !== resolve(worktree));
  writeStartupRegistry(mainWorktree, registryDir, data);
}
