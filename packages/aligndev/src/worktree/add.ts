import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { errorMessage } from "../errors.js";
import { canonicalPath, git, isInside, pathExists, type Repository } from "./git.js";
import {
  type DirectoryPreparation,
  finishSetup,
  prepareDirectories,
  type WorktreeReport,
} from "./setup.js";
import type { WorktreeContext } from "./worktree-cli.js";

export interface AddOptions {
  path: string;
  branch: string;
  newBranch: boolean;
  start?: string;
}

interface PreparedAdd extends DirectoryPreparation {
  destination: string;
  branch: BranchPlan;
}

interface BranchPlan {
  create: boolean;
  start: string;
  commit: string;
  track: boolean;
}

export function addWorktree(
  ctx: WorktreeContext,
  repo: Repository,
  options: AddOptions,
): WorktreeReport {
  const prepared = prepareAdd(ctx, repo, options);
  createGitWorktree(ctx, options, prepared);
  return finishSetup(
    ctx,
    repo,
    prepared.destination,
    { directories: prepared.directories, warnings: prepared.warnings },
    options.branch,
  );
}

function prepareAdd(ctx: WorktreeContext, repo: Repository, options: AddOptions): PreparedAdd {
  const destination = validateDestination(ctx, repo, options.path);
  const branch = prepareBranch(ctx, repo, options);
  const prepared = prepareDirectories(ctx, repo, destination, branch.commit);
  return { destination, branch, ...prepared };
}

function validateDestination(ctx: WorktreeContext, repo: Repository, input: string): string {
  const literal = resolve(ctx.cwd, input);
  if (pathExists(literal)) throw new Error(`Destination already exists: ${literal}`);
  const destination = canonicalPath(literal);
  let ancestor = dirname(destination);
  while (!pathExists(ancestor)) ancestor = dirname(ancestor);
  if (!statSync(ancestor).isDirectory())
    throw new Error(`Destination parent is not a directory: ${ancestor}`);
  for (const tree of repo.worktrees) {
    if (isInside(tree.path, destination) || isInside(destination, tree.path)) {
      throw new Error(
        `Destination overlaps registered worktree ${tree.path}. Choose a new sibling directory.`,
      );
    }
  }
  return destination;
}

function prepareBranch(ctx: WorktreeContext, repo: Repository, options: AddOptions): BranchPlan {
  git(ctx, "check-ref-format", `refs/heads/${options.branch}`);
  if (options.branch.startsWith("-") || options.branch === "HEAD")
    throw new Error("Invalid branch name.");
  const occupied = repo.worktrees.find((tree) => tree.branch === options.branch);
  if (occupied !== undefined)
    throw new Error(
      `Branch ${options.branch} is already checked out at ${occupied.path}; reuse that worktree.`,
    );
  const localRef = `refs/heads/${options.branch}`;
  const locals = git(ctx, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n");
  const exists = locals.includes(localRef);
  if (options.newBranch && exists) throw new Error(`Branch already exists: ${options.branch}`);
  let start = options.start ?? "HEAD";
  let create = options.newBranch;
  let track = false;
  if (!options.newBranch) {
    if (exists) start = localRef;
    else {
      const remotes = git(ctx, "for-each-ref", "--format=%(refname)", "refs/remotes")
        .trim()
        .split("\n")
        .filter(
          (ref) =>
            ref.slice("refs/remotes/".length).split("/").slice(1).join("/") === options.branch,
        );
      if (remotes.length !== 1 || remotes[0] === undefined) {
        throw new Error(
          remotes.length === 0
            ? `No local or fetched remote branch: ${options.branch}`
            : `Ambiguous remote branch ${options.branch}: ${remotes.join(", ")}. Choose explicitly with -b <branch> <remote/ref>.`,
        );
      }
      start = remotes[0];
      create = true;
      track = true;
    }
  }
  const commit = git(ctx, "rev-parse", "--verify", "--end-of-options", `${start}^{commit}`).trim();
  return { create, start: !create ? options.branch : start, commit, track };
}

function createGitWorktree(ctx: WorktreeContext, options: AddOptions, prepared: PreparedAdd): void {
  const { branch, destination } = prepared;
  const createArgs = branch.create
    ? ["-b", options.branch, ...(branch.track ? ["--track"] : [])]
    : [];
  try {
    git(ctx, "worktree", "add", ...createArgs, "--", destination, branch.start);
  } catch (error) {
    throw new Error(
      `Git worktree creation failed: ${errorMessage(error)}\nInspect ${destination} and branch ${options.branch} for partial effects before retrying. No rollback was attempted.`,
    );
  }
}
