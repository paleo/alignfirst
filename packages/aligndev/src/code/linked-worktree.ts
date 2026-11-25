import { realpathSync } from "node:fs";

import { git, type GitContext } from "@alignfirst/workspace/git";

// A linked worktree's repository lives in the main checkout's git directory, outside the worktree.
// Undefined in a main checkout, or outside a git repository.
export function readLinkedGitCommonDir(ctx: GitContext): string | undefined {
  try {
    const output = git(ctx, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir");
    const [gitDir, commonDir] = output
      .trimEnd()
      .split("\n")
      .map((path) => realpathSync(path));
    return gitDir === commonDir ? undefined : commonDir;
  } catch {
    return;
  }
}
