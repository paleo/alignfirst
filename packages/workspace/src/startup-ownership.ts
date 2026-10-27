import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import { withRegistryLock } from "./registry-lock.js";
import { readRegistry, writeRegistry } from "./registry-storage.js";

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

interface StartupOwners {
  owners: StartupOwner[];
}

/** The claim survives hooks without holding the registry lock. Only a dead PID is abandoned. */
export async function claimStartup(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<StartupOwner> {
  return withRegistryLock(mainWorktree, registryDir, () => {
    const data = readOwners(mainWorktree, registryDir);
    const path = resolve(worktree);
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
  const current = readOwners(mainWorktree, registryDir).owners.find(
    (entry) => entry.worktree === owner.worktree,
  );
  if (current?.id !== owner.id) {
    throw new WorkspaceError(`Dev-server startup ownership lost for ${owner.worktree}.`);
  }
}

export async function releaseStartup(
  mainWorktree: string,
  registryDir: string,
  owner: StartupOwner,
): Promise<void> {
  await withRegistryLock(mainWorktree, registryDir, () => {
    const data = readOwners(mainWorktree, registryDir);
    data.owners = data.owners.filter(
      (entry) => entry.worktree !== owner.worktree || entry.id !== owner.id,
    );
    writeOwners(mainWorktree, registryDir, data);
  });
}

function readOwners(mainWorktree: string, registryDir: string): StartupOwners {
  const path = join(mainWorktree, registryDir, FILENAME);
  const data = readRegistry<StartupOwners>(path, SCHEMA, { owners: [] }, mainWorktree);
  const paths = data.owners.map((owner) => resolve(owner.worktree));
  if (new Set(paths).size !== paths.length)
    throw new WorkspaceError(`Invalid registry ${path}: duplicate startup identities.`);
  return { owners: data.owners.map((owner) => ({ ...owner, worktree: resolve(owner.worktree) })) };
}

function writeOwners(mainWorktree: string, registryDir: string, data: StartupOwners): void {
  writeRegistry(
    join(mainWorktree, registryDir, FILENAME),
    { version: 1, ...data },
    SCHEMA,
    mainWorktree,
  );
}
