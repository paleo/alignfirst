import { realpathSync } from "node:fs";
import { join } from "node:path";

import { WorkspaceError } from "./errors.js";
import { canonicalPath, isInside, pathExists, readRepository, type GitContext } from "./git.js";
import type { WorkspaceHost } from "./operation.js";

export async function assertDeletionSafe(
  source: GitContext,
  target: string,
  host?: WorkspaceHost,
): Promise<void> {
  const repo = readRepository(source);
  const path = canonicalPath(target);
  if (path === repo.mainWorktree)
    throw new WorkspaceError(`Cannot remove the main worktree: ${path}`);
  const tree = repo.worktrees.find((tree) => tree.path === path);
  if (tree?.locked) throw new WorkspaceError(`Cannot remove locked worktree: ${path}`);
  const nested = repo.worktrees.find((tree) => tree.path !== path && isInside(path, tree.path));
  if (nested)
    throw new WorkspaceError(
      `Cannot remove ${path}: it contains another registered worktree root: ${nested.path}.`,
    );
  for (const tree of repo.worktrees.filter((tree) => tree.exists)) {
    const protection = await host?.sharedDirectoryProtection(tree.path);
    const paths = protection?.protectedPaths ?? [];
    if (tree.path !== path) {
      for (const name of [".local", ".plans"]) {
        const location = join(tree.path, name);
        if (pathExists(location)) {
          try {
            paths.push(realpathSync(location));
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              (error.code !== "ENOENT" && error.code !== "ENOTDIR")
            )
              throw error;
          }
        }
      }
    }
    for (const protectedPath of paths) {
      if (isInside(path, protectedPath))
        throw new WorkspaceError(
          `Cannot remove ${path}: it contains protected shared directory ${protectedPath} referenced by ${tree.path}.`,
        );
    }
  }
}
