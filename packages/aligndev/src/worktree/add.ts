import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { errorMessage } from "../errors.js";
import type { ProjectReport } from "../project/layout.js";
import { readReport, validateEffectivePlans } from "../project/plans.js";
import {
  canonicalPath,
  git,
  isInside,
  isProjectTrackedDirectory,
  pathExists,
  readRepository,
  type Repository,
  type Worktree,
} from "./git.js";
import type { WorktreeContext } from "./worktree-cli.js";

export interface AddOptions {
  path: string;
  branch: string;
  newBranch: boolean;
  start?: string;
}

export interface AddReport {
  mainWorktree: string;
  worktree: Worktree;
  directories: Record<".local" | ".plans", DirectoryReport>;
  warnings: string[];
}

export interface DirectoryReport {
  path: string;
  mode: "symlink" | "tracked" | "companion" | "absent";
  target: string | null;
}

interface PreparedAdd {
  destination: string;
  branch: BranchPlan;
  directories: Record<".local" | ".plans", DirectoryReport>;
  warnings: string[];
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
): AddReport {
  const prepared = prepareAdd(ctx, repo, options);
  createGitWorktree(ctx, options, prepared);
  return finishSetup(ctx, repo, options, prepared);
}

function prepareAdd(ctx: WorktreeContext, repo: Repository, options: AddOptions): PreparedAdd {
  const destination = validateDestination(ctx, repo, options.path);
  const branch = prepareBranch(ctx, repo, options);
  const sourceCtx = { ...ctx, cwd: repo.mainWorktree };
  const sourceReport = readReport(sourceCtx);
  const plansTarget = validateEffectivePlans(sourceCtx);
  const warnings: string[] = [];
  const directories = planDirectories(
    sourceCtx,
    repo,
    destination,
    branch.commit,
    sourceReport,
    plansTarget,
    warnings,
  );
  return { destination, branch, directories, warnings };
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

function planDirectories(
  ctx: WorktreeContext,
  repo: Repository,
  destination: string,
  commit: string,
  report: ProjectReport,
  plansTarget: string,
  warnings: string[],
): Record<".local" | ".plans", DirectoryReport> {
  const local = planLocal(ctx, repo, destination, commit, warnings);
  const plans = report.locations[".plans"];
  if (plans.in === "companion") {
    return { ".local": local, ".plans": { path: plans.path, mode: "companion", target: null } };
  }
  if (targetTracks(ctx, commit, ".plans")) {
    throw new Error(
      `Target commit tracks .plans. See \`${ctx.forms.aligndev} guide work-files-setup\` for authorized preparation.`,
    );
  }
  return {
    ".local": local,
    ".plans": { path: join(destination, ".plans"), mode: "symlink", target: plansTarget },
  };
}

function planLocal(
  ctx: WorktreeContext,
  repo: Repository,
  destination: string,
  commit: string,
  warnings: string[],
): DirectoryReport {
  const path = join(destination, ".local");
  if (targetTracks(ctx, commit, ".local")) {
    warnings.push("Target branch tracks .local; it remains branch-local and is not shared.");
    return { path, mode: "tracked", target: null };
  }
  const source = join(repo.mainWorktree, ".local");
  if (!pathExists(source)) return { path, mode: "absent", target: null };
  if (!statSync(source).isDirectory())
    throw new Error(`Source is not a usable directory: ${source}`);
  const target = realpathSync(source);
  if (isProjectTrackedDirectory(ctx, source, repo.commonDir)) {
    warnings.push(
      "Main-worktree .local belongs to tracked content on another branch; leaving .local absent.",
    );
    return { path, mode: "absent", target: null };
  }
  return { path, mode: "symlink", target };
}

function targetTracks(ctx: WorktreeContext, commit: string, path: string): boolean {
  return (
    git(ctx, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit, "--", path)
      .length > 0
  );
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

function finishSetup(
  ctx: WorktreeContext,
  repo: Repository,
  options: AddOptions,
  prepared: PreparedAdd,
): AddReport {
  const { destination, directories, warnings } = prepared;
  let step = "directory links and local Git exclusions";
  try {
    const targetCtx = { ...ctx, cwd: destination };
    createLinks(targetCtx, repo, directories);
    step = "effective work-files verification";
    validateEffectivePlans(targetCtx);
    const worktree = readRepository(targetCtx).worktrees.find((tree) => tree.path === destination);
    if (worktree === undefined || worktree.branch !== options.branch) {
      throw new Error("Created worktree does not have the requested branch in Git's registry.");
    }
    return { mainWorktree: repo.mainWorktree, worktree, directories, warnings };
  } catch (error) {
    throw new Error(
      `Worktree setup failed during ${step}: ${errorMessage(error)}\n` +
        `Retained worktree ${destination} and branch ${options.branch}. Inspect and repair the failed step manually, ` +
        `or remove it with \`${ctx.forms.aligndev} worktree remove ${quotePath(destination)}\` after preserving any work. No rollback was attempted.`,
    );
  }
}

function quotePath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function createLinks(
  ctx: WorktreeContext,
  repo: Repository,
  directories: Record<string, DirectoryReport>,
): void {
  const links = Object.entries(directories).filter(([, directory]) => directory.mode === "symlink");
  if (links.length === 0) return;
  for (const [name, directory] of links) {
    if (directory.target === null) throw new Error("Missing symlink target.");
    symlinkSync(join(repo.mainWorktree, name), directory.path, "dir");
  }
  const exclude = git(
    { ...ctx, cwd: repo.mainWorktree },
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ).trim();
  let content = pathExists(exclude) ? readFileSync(exclude, "utf8") : "";
  for (const [name] of links) {
    const pattern = `/${name}`;
    if (!content.split(/\r?\n/u).includes(pattern)) {
      mkdirSync(dirname(exclude), { recursive: true });
      const addition = `${content.endsWith("\n") || content === "" ? "" : "\n"}${pattern}\n`;
      appendFileSync(exclude, addition);
      content += addition;
    }
  }
  for (const [name, directory] of links) {
    try {
      git(ctx, "check-ignore", "-q", "--", name);
    } catch {
      throw new Error(
        `Generated link ${directory.path} is not ignored. Inspect conflicting tracked ignore rules; they were not edited.`,
      );
    }
    if (realpathSync(directory.path) !== directory.target)
      throw new Error(`Link target changed: ${directory.path}`);
  }
}
