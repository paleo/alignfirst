import { existsSync } from "node:fs";

import type { SlotsRegistry } from "./slots.js";

/**
 * Returns the slot ports whose worktree directory no longer exists on disk — workspaces deleted
 * out-of-band (a manual `rm -rf`, a bare `git worktree remove`). The main worktree is never
 * reported: if its directory is gone the whole git context is, and we must not touch it.
 */
export function findOrphanPorts(
  registry: SlotsRegistry,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return Object.entries(registry.slots)
    .filter(([, entry]) => !entry.main && !exists(entry.worktree))
    .map(([port]) => port);
}
