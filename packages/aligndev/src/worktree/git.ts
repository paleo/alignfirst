import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { isNodeError } from "../errors.js";

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

export function repositoryIdentity(ctx: GitContext): string {
  return realpathSync(git(ctx, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
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

export function git(ctx: GitContext, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
