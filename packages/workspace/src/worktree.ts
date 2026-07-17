import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";

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

export function useExistingBranch(
  branch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn = defaultWorktreeDirName,
): WorktreeContext {
  if (!branchExists(branch)) {
    throw new WorkspaceError(`Branch "${branch}" does not exist locally or on the remote.`);
  }
  const worktreePath = dedupeWorktreePath(computeWorktreePath(ctx.mainWorktree, branch, dirNameFn));
  execFileSync("git", ["worktree", "add", worktreePath, branch], { stdio: stdioFor(run) });
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

export interface CreateBranchOptions {
  dirNameFn?: WorktreeDirNameFn;
  /** Commit-ish the new branch starts from; the current HEAD when omitted. */
  from?: string;
  /** When the name is taken, append `-2`, `-3`… instead of failing. */
  dedupe?: boolean;
}

export function createBranch(
  requestedBranch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  options: CreateBranchOptions = {},
): WorktreeContext {
  const { dirNameFn = defaultWorktreeDirName, from, dedupe = false } = options;
  if (from !== undefined) verifyFromRef(from);

  const ancestor = findAncestorBranchConflict(requestedBranch);
  if (ancestor !== undefined) {
    throw new WorkspaceError(
      `Branch name "${requestedBranch}" conflicts with existing branch "${ancestor}": ` +
        "git cannot nest a branch under another branch. " +
        "Choose a different name (--dedupe cannot resolve this).",
    );
  }

  const finalBranch = resolveNewBranchName(requestedBranch, ctx, dirNameFn, dedupe);
  const worktreePath = dedupeWorktreePath(
    computeWorktreePath(ctx.mainWorktree, finalBranch, dirNameFn),
  );
  const addArgs = ["worktree", "add", "-b", finalBranch, "--end-of-options", worktreePath];
  if (from !== undefined) addArgs.push(from);
  execFileSync("git", addArgs, { stdio: stdioFor(run) });
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

function verifyFromRef(from: string): void {
  try {
    // `^{commit}` accepts any commit-ish: branch, origin/x, tag, SHA.
    // `--end-of-options` guards against option-like refs (rev-parse treats args after `--` as paths).
    execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${from}^{commit}`], {
      stdio: "pipe",
    });
  } catch {
    throw new WorkspaceError(`--from ref "${from}" does not resolve to a commit.`);
  }
}

/** Returns an existing ancestor prefix (`a`, then `a/b` for `a/b/c`) that would block nesting. */
function findAncestorBranchConflict(branch: string): string | undefined {
  const parts = branch.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; ++i) {
    prefix = prefix === "" ? parts[i] : `${prefix}/${parts[i]}`;
    if (branchExists(prefix)) return prefix;
  }
  return undefined;
}

function resolveNewBranchName(
  requestedBranch: string,
  ctx: WorktreeContext,
  dirNameFn: WorktreeDirNameFn,
  dedupe: boolean,
): string {
  const exact = branchExists(requestedBranch);
  const namespace = exact ? undefined : findNamespaceConflict(requestedBranch);
  if (!exact && namespace === undefined) return requestedBranch;
  if (!dedupe) {
    const detail = exact
      ? `Branch "${requestedBranch}" already exists.`
      : `Branch name "${requestedBranch}" conflicts with existing branch "${namespace}".`;
    throw new WorkspaceError(`${detail} Pass --dedupe to append -2, -3…, or choose another name.`);
  }
  return dedupeBranchName(requestedBranch, ctx, dirNameFn);
}

function branchNameTaken(name: string): boolean {
  return branchExists(name) || findNamespaceConflict(name) !== undefined;
}

/** Returns an example ref under `refs/heads/<branch>/` or `refs/remotes/origin/<branch>/`, if any. */
function findNamespaceConflict(branch: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      [
        "for-each-ref",
        "--count=1",
        "--format=%(refname:short)",
        `refs/heads/${branch}/`,
        `refs/remotes/origin/${branch}/`,
      ],
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

const MAX_ALIGNED_SUFFIX_ATTEMPTS = 100;

/**
 * Suffix loop for `--dedupe`: prefers a candidate whose branch name is free **and** whose worktree
 * directory does not yet exist, so branch and directory stay aligned. Bounded at
 * {@link MAX_ALIGNED_SUFFIX_ATTEMPTS}; past that, the first branch-free name wins and the always-on
 * directory dedupe resolves the path (the default dir-name caps slugs, collapsing many names to one dir).
 */
function dedupeBranchName(
  requestedBranch: string,
  ctx: WorktreeContext,
  dirNameFn: WorktreeDirNameFn,
): string {
  let firstFree: string | undefined;
  for (let suffix = 2; suffix < 2 + MAX_ALIGNED_SUFFIX_ATTEMPTS; ++suffix) {
    const candidate = `${requestedBranch}-${suffix}`;
    if (branchNameTaken(candidate)) continue;
    firstFree ??= candidate;
    if (!existsSync(computeWorktreePath(ctx.mainWorktree, candidate, dirNameFn))) {
      return warnSuffix(requestedBranch, candidate);
    }
  }
  return warnSuffix(requestedBranch, firstFree ?? firstFreeBranchName(requestedBranch));
}

function firstFreeBranchName(requestedBranch: string): string {
  let suffix = 2 + MAX_ALIGNED_SUFFIX_ATTEMPTS;
  while (branchNameTaken(`${requestedBranch}-${suffix}`)) ++suffix;
  return `${requestedBranch}-${suffix}`;
}

function warnSuffix(requestedBranch: string, finalBranch: string): string {
  console.warn(
    `Warning: Branch "${requestedBranch}" already exists; using "${finalBranch}" instead.`,
  );
  return finalBranch;
}

export function isWorktreeDirty(worktreePath: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      stdio: "pipe",
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch {
    console.error(
      `Error: Cannot check for uncommitted changes in ${worktreePath}. Pass --force to remove anyway.`,
    );
    process.exit(1);
  }
}

export function getWorktreeBranch(worktreePath: string): string | undefined {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], {
      stdio: "pipe",
      cwd: worktreePath,
    })
      .toString("utf-8")
      .trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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
