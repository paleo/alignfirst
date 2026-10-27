import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import {
  canonicalPath,
  git,
  headCommit,
  isInside,
  pathExists,
  readRepository,
  worktreeRoot,
} from "./git.js";
import type { WorkspaceOutput } from "./operation.js";

const MAX_ALIGNED_SUFFIX_ATTEMPTS = 100;

export interface WorktreeContext {
  currentWorktree: string;
  mainWorktree: string;
  isMainWorktree: boolean;
}

export interface RunCtx {
  verbose: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: WorkspaceOutput;
}

export function detectWorktree(cwd: string): WorktreeContext {
  const source = { cwd, env: process.env };
  const currentWorktree = worktreeRoot(source);
  const { mainWorktree } = readRepository(source);
  const isMainWorktree = resolve(currentWorktree) === resolve(mainWorktree);
  return { currentWorktree, mainWorktree, isMainWorktree };
}

export function useExistingBranch(
  branch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn = defaultWorktreeDirName,
  options: CreateBranchOptions = {},
): WorktreeContext {
  const source = { cwd: ctx.currentWorktree, env: run.env ?? process.env };
  const repo = readRepository(source);
  const occupied = repo.worktrees.find((tree) => tree.branch === branch);
  if (occupied)
    throw new WorkspaceError(`Branch ${branch} is already checked out at ${occupied.path}.`);
  const local = git(source, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n");
  let start = `refs/heads/${branch}`;
  let tracking = false;
  if (!local.includes(start)) {
    const remotes = git(source, "for-each-ref", "--format=%(refname)", "refs/remotes")
      .split("\n")
      .filter((ref) => ref.slice("refs/remotes/".length).split("/").slice(1).join("/") === branch);
    if (remotes.length !== 1)
      throw new WorkspaceError(
        remotes.length === 0
          ? `No local or fetched remote branch: ${branch}`
          : `Ambiguous remote branch ${branch}: ${remotes.join(", ")}.`,
      );
    start = remotes[0];
    tracking = true;
  }
  validateBranch(branch, source);
  const worktreePath = selectDestination(ctx, run, branch, dirNameFn, options.path);
  options.beforeCreate?.(start);
  runGitWorktree(
    [
      "worktree",
      "add",
      ...(tracking ? ["--track", "-b", branch] : []),
      "--",
      worktreePath,
      tracking ? start : branch,
    ],
    ctx.currentWorktree,
    run,
  );
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

export interface CreateBranchOptions {
  dirNameFn?: WorktreeDirNameFn;
  /** Commit-ish the new branch starts from; the current HEAD when omitted. */
  from?: string;
  /** When the name is taken, append `-2`, `-3`… instead of failing. */
  dedupe?: boolean;
  path?: string;
  beforeCreate?: (commit: string) => void;
}

export function createBranch(
  requestedBranch: string,
  ctx: WorktreeContext,
  run: RunCtx,
  options: CreateBranchOptions = {},
): WorktreeContext {
  const { dirNameFn = defaultWorktreeDirName, from, dedupe = false } = options;
  const source = { cwd: ctx.currentWorktree, env: run.env ?? process.env };
  validateBranch(requestedBranch, source);
  if (from !== undefined) verifyFromRef(from, ctx.currentWorktree);
  else if (headCommit(source) === undefined)
    throw new WorkspaceError(
      "HEAD has no commit. Make the initial commit before creating a linked workspace.",
    );

  const ancestor = findAncestorBranchConflict(requestedBranch, ctx.currentWorktree);
  if (ancestor !== undefined) {
    throw new WorkspaceError(
      `Branch name "${requestedBranch}" conflicts with existing branch "${ancestor}": ` +
        "git cannot nest a branch under another branch. " +
        "Choose a different name (--dedupe cannot resolve this).",
    );
  }

  const finalBranch = resolveNewBranchName(requestedBranch, ctx, dirNameFn, dedupe);
  if (finalBranch !== requestedBranch)
    run.output?.diagnostic(
      `Warning: Branch "${requestedBranch}" is taken; using "${finalBranch}" instead.`,
    );
  const worktreePath = selectDestination(ctx, run, finalBranch, dirNameFn, options.path);
  options.beforeCreate?.(from ?? "HEAD");
  const addArgs = [
    "worktree",
    "add",
    "--no-track",
    "-b",
    finalBranch,
    "--end-of-options",
    worktreePath,
  ];
  if (from !== undefined) addArgs.push(from);
  runGitWorktree(addArgs, ctx.currentWorktree, run);
  return { ...ctx, currentWorktree: worktreePath, isMainWorktree: false };
}

function validateBranch(branch: string, source: { cwd: string; env: NodeJS.ProcessEnv }): void {
  if (branch.startsWith("-") || branch === "HEAD") throw new WorkspaceError("Invalid branch name.");
  git(source, "check-ref-format", `refs/heads/${branch}`);
}

function selectDestination(
  ctx: WorktreeContext,
  run: RunCtx,
  branch: string,
  dirNameFn: WorktreeDirNameFn,
  path?: string,
): string {
  const candidate =
    path === undefined
      ? dedupeWorktreePath(computeWorktreePath(ctx.mainWorktree, branch, dirNameFn))
      : resolve(run.cwd ?? ctx.currentWorktree, path);
  if (pathExists(candidate)) throw new WorkspaceError(`Destination already exists: ${candidate}`);
  const destination = canonicalPath(candidate);
  let ancestor = dirname(destination);
  while (!pathExists(ancestor)) ancestor = dirname(ancestor);
  if (!statSync(ancestor).isDirectory())
    throw new WorkspaceError(`Destination parent is not a directory: ${ancestor}`);
  const repo = readRepository({ cwd: ctx.currentWorktree, env: run.env ?? process.env });
  for (const tree of repo.worktrees) {
    if (isInside(tree.path, destination) || isInside(destination, tree.path))
      throw new WorkspaceError(
        `Destination overlaps registered worktree ${tree.path}. Choose a new sibling directory.`,
      );
  }
  return destination;
}

function verifyFromRef(from: string, cwd: string): void {
  try {
    // `^{commit}` accepts any commit-ish: branch, origin/x, tag, SHA.
    // `--end-of-options` guards against option-like refs (rev-parse treats args after `--` as paths).
    execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${from}^{commit}`], {
      cwd,
      stdio: "pipe",
    });
  } catch {
    throw new WorkspaceError(`--from ref "${from}" does not resolve to a commit.`);
  }
}

/** Returns an existing ancestor prefix (`a`, then `a/b` for `a/b/c`) that would block nesting. */
function findAncestorBranchConflict(branch: string, cwd: string): string | undefined {
  const parts = branch.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; ++i) {
    prefix = prefix === "" ? parts[i] : `${prefix}/${parts[i]}`;
    if (branchExists(prefix, cwd)) return prefix;
  }
  return undefined;
}

function resolveNewBranchName(
  requestedBranch: string,
  ctx: WorktreeContext,
  dirNameFn: WorktreeDirNameFn,
  dedupe: boolean,
): string {
  const exact = branchExists(requestedBranch, ctx.currentWorktree);
  const namespace = exact ? undefined : findNamespaceConflict(requestedBranch, ctx.currentWorktree);
  if (!exact && namespace === undefined) return requestedBranch;
  if (!dedupe) {
    const detail = exact
      ? `Branch "${requestedBranch}" already exists.`
      : `Branch name "${requestedBranch}" conflicts with existing branch "${namespace}".`;
    throw new WorkspaceError(`${detail} Pass --dedupe to append -2, -3…, or choose another name.`);
  }
  return dedupeBranchName(requestedBranch, ctx, dirNameFn);
}

function branchNameTaken(name: string, cwd: string): boolean {
  return branchExists(name, cwd) || findNamespaceConflict(name, cwd) !== undefined;
}

function findNamespaceConflict(branch: string, cwd: string): string | undefined {
  return branchNames(cwd).find((name) => name.startsWith(`${branch}/`));
}

function branchNames(cwd: string): string[] {
  return git(
    { cwd, env: process.env },
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  )
    .split("\n")
    .filter((ref) => ref !== "")
    .map((ref) =>
      ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref.slice("refs/remotes/".length).split("/").slice(1).join("/"),
    );
}

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
    if (branchNameTaken(candidate, ctx.currentWorktree)) continue;
    firstFree ??= candidate;
    if (!pathExists(computeWorktreePath(ctx.mainWorktree, candidate, dirNameFn))) {
      return candidate;
    }
  }
  return firstFree ?? firstFreeBranchName(requestedBranch, ctx.currentWorktree);
}

function firstFreeBranchName(requestedBranch: string, cwd: string): string {
  let suffix = 2 + MAX_ALIGNED_SUFFIX_ATTEMPTS;
  while (branchNameTaken(`${requestedBranch}-${suffix}`, cwd)) ++suffix;
  return `${requestedBranch}-${suffix}`;
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
    throw new WorkspaceError(
      `Cannot check for uncommitted changes in ${worktreePath}. Pass --force to remove anyway.`,
    );
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
  runGitWorktree(["worktree", "remove", "--force", worktreePath], run.cwd, run);
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
  if (!pathExists(candidate)) return candidate;
  let suffix = 2;
  while (pathExists(`${candidate}-${suffix}`)) {
    ++suffix;
  }
  return `${candidate}-${suffix}`;
}

function branchExists(branch: string, cwd: string): boolean {
  return branchNames(cwd).includes(branch);
}

function runGitWorktree(args: string[], cwd: string | undefined, run: RunCtx): void {
  const result = spawnSync("git", args, { cwd, env: run.env, encoding: "utf8", stdio: "pipe" });
  if (run.verbose) {
    if (result.stdout !== null && result.stdout !== "") run.output?.write(result.stdout);
    if (result.stderr !== null && result.stderr !== "")
      run.output?.diagnostic(result.stderr.trimEnd());
  }
  if (result.error || result.signal !== null || result.status !== 0) {
    throw new WorkspaceError(
      `Git worktree operation failed: ${result.stderr?.trim() ?? result.error?.message ?? result.signal}`,
      { cause: result.error },
    );
  }
}
