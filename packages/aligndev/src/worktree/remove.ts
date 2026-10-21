import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { readProjectReport } from "../project/layout.js";
import { canonicalPath, git, isInside, pathExists, type Repository } from "./git.js";
import type { WorktreeContext } from "./worktree-cli.js";

export interface RemoveReport {
  mainWorktree: string;
  path: string;
  removed: true;
}

export function removeWorktree(
  ctx: WorktreeContext,
  repo: Repository,
  input: string,
): RemoveReport {
  const path = canonicalPath(resolve(ctx.cwd, input));
  const target = repo.worktrees.find((tree) => tree.path === path);
  if (target === undefined)
    throw new Error(`Not an exact registered worktree root of this repository: ${path}`);
  if (target.main) throw new Error(`Cannot remove the main worktree: ${path}`);
  if (target.locked) throw new Error(`Cannot remove locked worktree: ${path}`);
  if (!target.exists)
    throw new Error(`Worktree is missing: ${path}. Inspect Git's registration manually.`);
  if (
    git({ ...ctx, cwd: path }, "status", "--porcelain", "-z", "--untracked-files=all").length > 0
  ) {
    throw new Error(
      `Cannot remove dirty worktree: ${path}. Preserve staged, modified and untracked files first.`,
    );
  }
  protectSharedDirectories(ctx, repo, path);
  git({ ...ctx, cwd: repo.mainWorktree }, "worktree", "remove", "--", path);
  return { mainWorktree: repo.mainWorktree, path, removed: true };
}

function protectSharedDirectories(ctx: WorktreeContext, repo: Repository, target: string): void {
  for (const tree of repo.worktrees.filter((candidate) => candidate.exists)) {
    const report = readProjectReport(ctx.alignfirstCommand, tree.path, ctx.env);
    if ("error" in report)
      throw new Error(
        `Cannot read shared-directory protection report for ${tree.path}: ${report.error}`,
      );
    const protectedPaths: string[] = [];
    if (report.companion !== null) protectedPaths.push(canonicalPath(report.companion.dir));
    for (const name of [".plans", "_aligndev"] as const) {
      const location = report.locations[name];
      if (location.exists) protectedPaths.push(realpathSync(location.path));
    }
    if (tree.path !== target) {
      for (const name of [".local", ".plans"]) {
        const source = join(tree.path, name);
        if (pathExists(source)) protectedPaths.push(realpathSync(source));
      }
    }
    for (const path of protectedPaths) {
      if (isInside(target, path)) {
        throw new Error(
          `Cannot remove ${target}: it contains protected shared directory ${path} referenced by ${tree.path}.`,
        );
      }
    }
  }
}
