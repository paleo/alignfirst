import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeContext {
  currentWorktree: string;
  mainWorktree: string;
  isMainWorktree: boolean;
}

export interface RunCtx {
  verbose: boolean;
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

export function enforceWorktreeMode(
  args: { use?: string; create?: string; here?: boolean },
  ctx: WorktreeContext,
): void {
  if (args.use || args.create) {
    if (!ctx.isMainWorktree) {
      console.error("Error: --use and --create must be run from the main worktree.");
      process.exit(1);
    }
  }
  // --here runs in any worktree: linked worktree (retry path) or main (initial bootstrap).
}

export function useExistingBranch(
  branch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn = defaultWorktreeDirName,
): WorktreeContext {
  if (!branchExists(branch)) {
    console.error(`Error: Branch "${branch}" does not exist locally or on the remote.`);
    process.exit(1);
  }
  const worktreePath = dedupeWorktreePath(computeWorktreePath(ctx.mainWorktree, branch, dirNameFn));
  execFileSync("git", ["worktree", "add", worktreePath, branch], { stdio: stdioFor(run) });
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

export function createBranch(
  requestedBranch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn = defaultWorktreeDirName,
): WorktreeContext {
  let finalBranch = requestedBranch;
  if (branchExists(finalBranch)) {
    let suffix = 2;
    while (branchExists(`${requestedBranch}-${suffix}`)) {
      ++suffix;
    }
    finalBranch = `${requestedBranch}-${suffix}`;
    console.warn(
      `Warning: Branch "${requestedBranch}" already exists; using "${finalBranch}" instead.`,
    );
  }
  const worktreePath = dedupeWorktreePath(
    computeWorktreePath(ctx.mainWorktree, finalBranch, dirNameFn),
  );
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

export function removeWorktree(worktreePath: string, run: RunCtx): void {
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], { stdio: stdioFor(run) });
}

/** Pure function that produces the basename of a worktree directory from a branch. */
export type WorktreeDirNameFn = (opts: { branch: string; repoName: string }) => string;

/**
 * Default {@link WorktreeDirNameFn}. Strips a recognizable ticket suffix from the last branch
 * segment (`feat/ABC-123-extra` → `feat-ABC-123`), caps the result at 22 chars, and strips
 * trailing dashes. Falls back to the full sanitized branch when no ticket pattern is found.
 */
export const defaultWorktreeDirName: WorktreeDirNameFn = ({ branch, repoName }) => {
  return `${repoName}-${shortenBranchSegment(branch)}`;
};

function shortenBranchSegment(branch: string): string {
  const parts = branch.split("/");
  const last = parts[parts.length - 1] ?? "";
  const match = last.match(/^([A-Za-z]+-\d+|\d+)/);
  if (match) {
    parts[parts.length - 1] = match[1];
  }
  let result = parts.join("-");
  if (result.length > 22) {
    result = result.slice(0, 22);
  }
  return result.replace(/-+$/, "");
}

export function computeWorktreePath(
  mainWorktree: string,
  branch: string,
  dirNameFn: WorktreeDirNameFn = defaultWorktreeDirName,
): string {
  const repoName = basename(mainWorktree);
  return join(dirname(mainWorktree), dirNameFn({ branch, repoName }));
}

function dedupeWorktreePath(candidate: string): string {
  if (!existsSync(candidate)) return candidate;
  let suffix = 2;
  while (existsSync(`${candidate}-${suffix}`)) {
    ++suffix;
  }
  return `${candidate}-${suffix}`;
}

function branchExists(branch: string): boolean {
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

function stdioFor(ctx: RunCtx): "inherit" | "pipe" {
  return ctx.verbose ? "inherit" : "pipe";
}
