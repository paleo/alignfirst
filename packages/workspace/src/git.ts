import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { errorMessage } from "./errors.js";

export interface GitContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface Repository {
  mainWorktree: string;
  commonDir: string;
  worktrees: Worktree[];
}

export interface Worktree {
  path: string;
  branch: string | null;
  main: boolean;
  exists: boolean;
  locked: boolean;
  prunable: boolean;
}

export function readRepository(ctx: GitContext): Repository {
  const commonDir = repositoryIdentity(ctx);
  if (
    git(ctx, "rev-parse", "--is-inside-work-tree").trim() !== "true" ||
    basename(commonDir) !== ".git"
  ) {
    throw new Error("A supported non-bare Git worktree with a main .git directory is required.");
  }
  const mainWorktree = realpathSync(dirname(commonDir));
  const worktrees = readWorktrees(ctx, mainWorktree);
  if (!worktrees.some((tree) => tree.main)) {
    throw new Error("Cannot identify the main Git worktree.");
  }
  return { mainWorktree, commonDir, worktrees };
}

function repositoryIdentity(ctx: GitContext): string {
  return realpathSync(git(ctx, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
}

export function isProjectTrackedDirectory(
  ctx: GitContext,
  path: string,
  identity: string,
): boolean {
  const root = worktreeRoot(ctx);
  const logicalPath = join(realpathSync(dirname(path)), basename(path));
  if (
    isInside(root, logicalPath) &&
    hasTrackedFiles({ ...ctx, cwd: root }, relative(root, logicalPath))
  )
    return true;
  const resolved = realpathSync(path);
  const source = { ...ctx, cwd: resolved };
  if (optionalRepositoryIdentity(source) !== identity) return false;
  const sourceRoot = worktreeRoot(source);
  return hasTrackedFiles({ ...ctx, cwd: sourceRoot }, relative(sourceRoot, resolved));
}

function hasTrackedFiles(ctx: GitContext, path: string): boolean {
  const candidate = path === "" ? "." : path;
  if (git(ctx, "--literal-pathspecs", "ls-files", "-z", "--", candidate).length > 0) return true;
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: "utf8",
  });
  if (head.status === 1) return false;
  if (head.status !== 0)
    throw head.error ?? new Error(`Cannot inspect tracked source: ${path}. ${head.stderr}`);
  return (
    git(
      ctx,
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      head.stdout.trim(),
      "--",
      candidate,
    ).length > 0
  );
}

function optionalRepositoryIdentity(ctx: GitContext): string | undefined {
  try {
    return repositoryIdentity(ctx);
  } catch (error) {
    if (
      errorMessage(error).includes("not a git repository") ||
      (isNodeError(error) && error.code === "ENOENT")
    )
      return;
    throw error;
  }
}

export function readWorktrees(ctx: GitContext, mainWorktree: string): Worktree[] {
  return git(ctx, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter((record) => record.length > 0)
    .map((record) => parseWorktree(record, mainWorktree));
}

function parseWorktree(record: string, mainWorktree: string): Worktree {
  const fields = record.split("\0");
  const pathField = fields.find((field) => field.startsWith("worktree "));
  if (pathField === undefined) throw new Error("Git returned a worktree record without a path.");
  const path = canonicalPath(pathField.slice("worktree ".length));
  const branchField = fields.find((field) => field.startsWith("branch "));
  return {
    path,
    branch: branchField === undefined ? null : branchField.slice("branch refs/heads/".length),
    main: path === mainWorktree,
    exists: existsSync(path),
    locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
    prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
  };
}

export function worktreeRoot(ctx: GitContext): string {
  return canonicalPath(git(ctx, "rev-parse", "--show-toplevel").replace(/\n$/u, ""));
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
    const parent = dirname(path);
    return parent === path ? resolve(path) : resolve(canonicalPath(parent), basename(path));
  }
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function isInside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function git(ctx: GitContext, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
