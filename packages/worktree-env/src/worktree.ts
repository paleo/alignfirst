import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeContext {
  currentWorktree: string;
  mainWorktree: string;
  isMainWorktree: boolean;
}

export interface RunCtx {
  verbose: boolean;
}

function stdioFor(ctx: RunCtx): "inherit" | "pipe" {
  return ctx.verbose ? "inherit" : "pipe";
}

export function detectWorktree(): WorktreeContext {
  const currentWorktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf-8" },
  ).trim();
  const mainWorktree = dirname(gitCommonDir);
  const isMainWorktree = resolve(currentWorktree) === resolve(mainWorktree);
  return { currentWorktree, mainWorktree, isMainWorktree };
}

export function computeWorktreePath(mainWorktree: string, branch: string): string {
  const repoName = basename(mainWorktree);
  const sanitized = branch.replaceAll("/", "-");
  return join(dirname(mainWorktree), `${repoName}-${sanitized}`);
}

export function branchExists(branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], { stdio: "pipe" });
    return true;
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--verify", `origin/${branch}`], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
}

export function useExistingBranch(
  branch: string,
  ctx: WorktreeContext,
  run: RunCtx,
): WorktreeContext {
  if (!branchExists(branch)) {
    console.error(`Error: Branch "${branch}" does not exist locally or on the remote.`);
    process.exit(1);
  }
  const worktreePath = computeWorktreePath(ctx.mainWorktree, branch);
  execFileSync("git", ["worktree", "add", worktreePath, branch], { stdio: stdioFor(run) });
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

export function createBranch(
  requestedBranch: string,
  ctx: WorktreeContext,
  run: RunCtx,
): WorktreeContext {
  let finalBranch = requestedBranch;
  if (branchExists(finalBranch)) {
    let suffix = 2;
    while (branchExists(`${requestedBranch}-${suffix}`)) {
      ++suffix;
    }
    finalBranch = `${requestedBranch}-${suffix}`;
  }
  const worktreePath = computeWorktreePath(ctx.mainWorktree, finalBranch);
  execFileSync("git", ["worktree", "add", "-b", finalBranch, worktreePath], {
    stdio: stdioFor(run),
  });
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

export function verifyBranchAbsentFromRemote(branch: string, run: RunCtx): void {
  execFileSync("git", ["fetch"], { stdio: stdioFor(run) });
  const remoteBranches = execFileSync("git", ["branch", "-r", "--list", `origin/${branch}`], {
    encoding: "utf-8",
  }).trim();
  if (remoteBranches.length > 0) {
    console.error(
      `Error: Branch "${branch}" still exists on the remote. Use --no-remote-check to skip this verification.`,
    );
    process.exit(1);
  }
}

export function getCurrentBranch(worktreePath: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf-8",
    cwd: worktreePath,
  }).trim();
}

export function enforceWorktreeMode(
  args: { use?: string; create?: string; here?: boolean },
  ctx: WorktreeContext,
): void {
  if (args.use || args.create) {
    if (!ctx.isMainWorktree) {
      console.error("Error: --use and --create must be run from the main worktree.");
      process.exit(1);
    }
  } else if (args.here) {
    if (ctx.isMainWorktree) {
      console.error(
        "Error: --here must be run from a linked worktree, not from the main worktree.",
      );
      process.exit(1);
    }
  }
}

export function removeWorktree(worktreePath: string, run: RunCtx): void {
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { stdio: stdioFor(run) });
}
