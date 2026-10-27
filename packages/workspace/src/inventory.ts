import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { canonicalPath, readRepository, type GitContext } from "./git.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  type RuntimeOwner,
  type WorkspacesRegistry,
} from "./workspaces.js";

export interface WorkspaceInventory {
  mainWorktree: string;
  workspaces: WorkspaceRecord[];
}

export interface WorkspaceRecord {
  path: string;
  name: string | null;
  branch: string | null;
  main: boolean;
  exists: boolean;
  locked: boolean;
  prunable: boolean;
  preparation: "unprepared" | "pending" | "ready" | "failed";
  recipe: "defaults" | "manifest" | null;
  ports: Record<string, number>;
  devSetupFailure: string | null;
  runtime?: RuntimeOwner;
}

/** A read-only exact-path union; neither Git nor workspace registrations are repaired. */
export function readWorkspaceInventory(
  source: GitContext,
  registryDir: string,
): WorkspaceInventory {
  const repo = readRepository(source);
  const registry = readWorkspaces(repo.mainWorktree, registryDir);
  const paths = workspaceCandidatePaths(
    repo.worktrees.map((tree) => tree.path),
    registry,
  );
  const workspaces = [...paths]
    .map((path): WorkspaceRecord => {
      const tree = repo.worktrees.find((candidate) => candidate.path === path);
      const found = findWorkspaceByPath(registry, path);
      const entry = found?.entry;
      const runtime = Object.values(registry.runtimeOwners ?? {}).find(
        (owner) => owner.worktree === path,
      );
      return {
        path,
        name: found?.name ?? null,
        branch: tree?.branch ?? null,
        main: tree?.main ?? entry?.main ?? runtime?.main ?? false,
        exists: tree?.exists ?? existsSync(path),
        locked: tree?.locked ?? false,
        prunable: tree?.prunable ?? false,
        preparation: entry?.status ?? "unprepared",
        recipe: entry?.recipe.kind ?? null,
        ports: entry?.ports ?? {},
        devSetupFailure: entry?.devSetupFailure?.message ?? null,
        runtime,
      };
    })
    .sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
  return { mainWorktree: repo.mainWorktree, workspaces };
}

/** Exact-path candidates include runtime-only identities without inventing a registration. */
export function workspaceCandidatePaths(
  gitPaths: string[],
  registry: WorkspacesRegistry,
): string[] {
  return [
    ...new Set([
      ...gitPaths.map(canonicalPath),
      ...Object.values(registry.workspaces).map((entry) => canonicalPath(entry.worktree)),
      ...Object.values(registry.runtimeOwners ?? {}).map((owner) => owner.worktree),
    ]),
  ];
}

export function selectWorkspaceRecord(
  inventory: WorkspaceInventory,
  cwd: string,
  selector?: string,
): WorkspaceRecord {
  const path = canonicalPath(resolve(cwd, selector ?? "."));
  const record =
    inventory.workspaces.find((entry) => entry.path === path) ??
    (selector === undefined
      ? undefined
      : inventory.workspaces.find((entry) => entry.name === selector));
  if (!record)
    throw new WorkspaceError(
      `No workspace matching ${selector ?? path} (exact path or registered name).`,
    );
  return record;
}
