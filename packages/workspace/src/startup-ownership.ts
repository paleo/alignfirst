import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import { withRegistryLock } from "./registry-lock.js";
import { readRegistry, writeRegistry } from "./registry-storage.js";
import {
  assertRuntimeAvailable,
  assertWorkspaceCleanupComplete,
  findWorkspaceByPath,
  readWorkspaces,
  type WorkspacesRegistry,
} from "./workspaces.js";

const FILENAME = "dev-startups.json";
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "owners"],
  properties: {
    version: { const: 1 },
    owners: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["worktree", "id", "pid"],
        properties: {
          worktree: { type: "string", pattern: "^/" },
          id: { type: "string", minLength: 1 },
          pid: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

export interface StartupOwner {
  worktree: string;
  id: string;
  pid: number;
}

export interface StartupOwners {
  owners: StartupOwner[];
}

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
    assertWorkspaceCleanupComplete(findWorkspaceByPath(registry, path)?.entry);
    const existing = data.owners.find((owner) => owner.worktree === path);
    if (existing && isProcessAlive(existing.pid)) {
      throw new WorkspaceError(`Dev-server startup already in progress for ${path}.`);
    }
    const owner: StartupOwner = { worktree: path, id: randomUUID(), pid: process.pid };
    data.owners = data.owners.filter((entry) => entry.worktree !== path);
    data.owners.push(owner);
    writeOwners(mainWorktree, registryDir, data);
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
    writeOwners(mainWorktree, registryDir, data);
  });
}

export function readStartupOwners(mainWorktree: string, registryDir: string): StartupOwners {
  readWorkspaces(mainWorktree, registryDir);
  const path = resolve(mainWorktree, registryDir, FILENAME);
  const data = readRegistry<StartupOwners>(path, SCHEMA, { owners: [] }, mainWorktree);
  const paths = data.owners.map((owner) => resolve(owner.worktree));
  if (new Set(paths).size !== paths.length)
    throw new WorkspaceError(`Invalid registry ${path}: duplicate startup identities.`);
  return { owners: data.owners.map((owner) => ({ ...owner, worktree: resolve(owner.worktree) })) };
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
  writeOwners(mainWorktree, registryDir, data);
}

function writeOwners(mainWorktree: string, registryDir: string, data: StartupOwners): void {
  writeRegistry(
    resolve(mainWorktree, registryDir, FILENAME),
    { version: 1, ...data },
    SCHEMA,
    mainWorktree,
  );
}
