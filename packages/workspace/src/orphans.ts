import { existsSync } from "node:fs";

import type { WorkspacesRegistry } from "./workspaces.js";

/**
 * Returns the names of the workspaces whose worktree directory no longer exists on disk — deleted
 * out-of-band (a manual `rm -rf`, a bare `git worktree remove`). The main worktree is never
 * reported: if its directory is gone the whole git context is, and we must not touch it.
 */
export function findOrphanNames(
  registry: WorkspacesRegistry,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return Object.entries(registry.workspaces)
    .filter(([, entry]) => !entry.main && !exists(entry.worktree))
    .map(([name]) => name);
}
