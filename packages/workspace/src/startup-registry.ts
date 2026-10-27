import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
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

export interface StartupOwners {
  owners: StartupOwner[];
}

/** The caller validates workspace state before interpreting this sidecar. */
export function readStartupRegistry(mainWorktree: string, registryDir: string): StartupOwners {
  const path = resolve(mainWorktree, registryDir, FILENAME);
  const data = readRegistry<StartupOwners>(path, SCHEMA, { owners: [] }, mainWorktree);
  const paths = data.owners.map((owner) => resolve(owner.worktree));
  if (new Set(paths).size !== paths.length)
    throw new WorkspaceError(`Invalid registry ${path}: duplicate startup identities.`);
  return { owners: data.owners.map((owner) => ({ ...owner, worktree: resolve(owner.worktree) })) };
}

export function writeStartupRegistry(
  mainWorktree: string,
  registryDir: string,
  data: StartupOwners,
): void {
  writeRegistry(
    resolve(mainWorktree, registryDir, FILENAME),
    { version: 1, ...data },
    SCHEMA,
    mainWorktree,
  );
}
