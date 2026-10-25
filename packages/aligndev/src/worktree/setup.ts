import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { errorMessage } from "../errors.js";
import { readReport, validateEffectivePlans } from "../project/plans.js";
import {
  canonicalPath,
  git,
  isProjectTrackedDirectory,
  pathExists,
  readRepository,
  type Repository,
  type Worktree,
} from "./git.js";
import type { WorktreeContext } from "./worktree-cli.js";

export interface DirectoryPreparation {
  directories: Record<".local" | ".plans", DirectoryReport>;
  warnings: string[];
}

export interface DirectoryReport {
  path: string;
  mode: "directory" | "symlink" | "tracked" | "companion" | "absent";
  target: string | null;
}

export interface WorktreeReport extends DirectoryPreparation {
  mainWorktree: string;
  worktree: Worktree;
}

export function setupWorktree(
  ctx: WorktreeContext,
  repo: Repository,
  input?: string,
): WorktreeReport {
  const worktree = selectWorktree(ctx, repo, input);
  let prepared: DirectoryPreparation;
  try {
    if (worktree.main) return reportMain(ctx, repo, worktree);
    prepared = prepareDirectories(ctx, repo, worktree.path, "HEAD", true);
  } catch (error) {
    throw setupFailure(ctx, worktree.path, "directory preparation", error);
  }
  return finishSetup(ctx, repo, worktree.path, prepared);
}

function selectWorktree(ctx: WorktreeContext, repo: Repository, input?: string): Worktree {
  const path = canonicalPath(
    input === undefined ? git(ctx, "rev-parse", "--show-toplevel").trim() : resolve(ctx.cwd, input),
  );
  const worktree = repo.worktrees.find((tree) => tree.path === path);
  if (worktree === undefined || !worktree.exists || !pathExists(path)) {
    throw new Error(
      `Setup requires an existing registered worktree root of this repository: ${path}`,
    );
  }
  const targetCtx = { ...ctx, cwd: path };
  const targetRepo = readRepository(targetCtx);
  if (
    targetRepo.commonDir !== repo.commonDir ||
    canonicalPath(git(targetCtx, "rev-parse", "--show-toplevel").trim()) !== path
  ) {
    throw new Error(`Setup requires an exact registered worktree root: ${path}`);
  }
  return worktree;
}

function reportMain(ctx: WorktreeContext, repo: Repository, worktree: Worktree): WorktreeReport {
  const sourceCtx = { ...ctx, cwd: repo.mainWorktree };
  const report = readReport(sourceCtx);
  validateEffectivePlans(sourceCtx);
  const plans = report.locations[".plans"];
  return {
    mainWorktree: repo.mainWorktree,
    worktree,
    directories: {
      ".local": describeDirectory(join(repo.mainWorktree, ".local")),
      ".plans":
        plans.in === "companion"
          ? { path: plans.path, mode: "companion", target: null }
          : describeDirectory(plans.path),
    },
    warnings: [],
  };
}

function describeDirectory(path: string): DirectoryReport {
  if (!pathExists(path)) return { path, mode: "absent", target: null };
  if (!statSync(path).isDirectory()) throw new Error(`Source is not a usable directory: ${path}`);
  return lstatSync(path).isSymbolicLink()
    ? { path, mode: "symlink", target: realpathSync(path) }
    : { path, mode: "directory", target: null };
}

export function prepareDirectories(
  ctx: WorktreeContext,
  repo: Repository,
  destination: string,
  commit: string,
  includeIndex = false,
): DirectoryPreparation {
  const sourceCtx = { ...ctx, cwd: repo.mainWorktree };
  const report = readReport(sourceCtx);
  const plansTarget = validateEffectivePlans(sourceCtx);
  const targetCtx = includeIndex ? { ...ctx, cwd: destination } : sourceCtx;
  const warnings: string[] = [];
  const local = planLocal(sourceCtx, targetCtx, repo, destination, commit, includeIndex, warnings);
  const plans = report.locations[".plans"];
  if (plans.in === "companion") {
    return {
      directories: {
        ".local": local,
        ".plans": { path: plans.path, mode: "companion", target: null },
      },
      warnings,
    };
  }
  if (targetTracks(targetCtx, commit, ".plans", includeIndex)) {
    throw new Error(
      `Target commit${includeIndex ? " or index" : ""} tracks .plans. See the \`work-files-setup\` topic of \`${ctx.forms.aligndev} guide\` for authorized preparation.`,
    );
  }
  return {
    directories: {
      ".local": local,
      ".plans": { path: join(destination, ".plans"), mode: "symlink", target: plansTarget },
    },
    warnings,
  };
}

function planLocal(
  sourceCtx: WorktreeContext,
  targetCtx: WorktreeContext,
  repo: Repository,
  destination: string,
  commit: string,
  includeIndex: boolean,
  warnings: string[],
): DirectoryReport {
  const path = join(destination, ".local");
  if (targetTracks(targetCtx, commit, ".local", includeIndex)) {
    warnings.push("Target branch tracks .local; it remains branch-local and is not shared.");
    return { path, mode: "tracked", target: null };
  }
  const source = join(repo.mainWorktree, ".local");
  if (!pathExists(source)) return { path, mode: "absent", target: null };
  if (!statSync(source).isDirectory())
    throw new Error(`Source is not a usable directory: ${source}`);
  const target = realpathSync(source);
  if (isProjectTrackedDirectory(sourceCtx, source, repo.commonDir)) {
    warnings.push(
      "Main-worktree .local belongs to tracked content on another branch; leaving .local absent.",
    );
    return { path, mode: "absent", target: null };
  }
  return { path, mode: "symlink", target };
}

function targetTracks(
  ctx: WorktreeContext,
  commit: string,
  path: string,
  includeIndex: boolean,
): boolean {
  return (
    git(ctx, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit, "--", path)
      .length > 0 ||
    (includeIndex && git(ctx, "--literal-pathspecs", "ls-files", "-z", "--", path).length > 0)
  );
}

export function finishSetup(
  ctx: WorktreeContext,
  repo: Repository,
  destination: string,
  prepared: DirectoryPreparation,
  expectedBranch?: string,
): WorktreeReport {
  let step = "directory conflict checks";
  try {
    const targetCtx = { ...ctx, cwd: destination };
    checkDestinations(prepared.directories);
    step = "directory links and local Git exclusions";
    applyDirectories(targetCtx, repo, prepared.directories);
    step = "effective work-files verification";
    validateEffectivePlans(targetCtx);
    const worktree = readRepository(targetCtx).worktrees.find((tree) => tree.path === destination);
    if (
      worktree === undefined ||
      (expectedBranch !== undefined && worktree.branch !== expectedBranch)
    ) {
      throw new Error("Worktree does not have the requested branch in Git's registry.");
    }
    return { mainWorktree: repo.mainWorktree, worktree, ...prepared };
  } catch (error) {
    throw setupFailure(ctx, destination, step, error, expectedBranch);
  }
}

function checkDestinations(directories: Record<string, DirectoryReport>): void {
  for (const directory of Object.values(directories)) {
    if (directory.mode !== "symlink") continue;
    if (directory.target === null) throw new Error("Missing symlink target.");
    if (!pathExists(directory.path)) continue;
    if (lstatSync(directory.path).isSymbolicLink()) {
      try {
        if (realpathSync(directory.path) === directory.target) continue;
      } catch {
        // Broken and cyclic links are conflicts, not missing destinations.
      }
    }
    throw new Error(
      `Conflicting shared directory destination: ${directory.path}. Existing content was preserved.`,
    );
  }
}

function applyDirectories(
  ctx: WorktreeContext,
  repo: Repository,
  directories: Record<string, DirectoryReport>,
): void {
  const links = Object.entries(directories).filter(([, directory]) => directory.mode === "symlink");
  if (links.length === 0) return;
  for (const [name, directory] of links) {
    if (!pathExists(directory.path))
      symlinkSync(join(repo.mainWorktree, name), directory.path, "dir");
  }
  ensureExclusions(
    ctx,
    repo,
    links.map(([name]) => name),
  );
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

function ensureExclusions(ctx: WorktreeContext, repo: Repository, names: string[]): void {
  const exclude = git(
    { ...ctx, cwd: repo.mainWorktree },
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ).trim();
  let content = pathExists(exclude) ? readFileSync(exclude, "utf8") : "";
  for (const name of names) {
    const pattern = `/${name}`;
    if (content.split(/\r?\n/u).includes(pattern)) continue;
    mkdirSync(dirname(exclude), { recursive: true });
    const addition = `${content.endsWith("\n") || content === "" ? "" : "\n"}${pattern}\n`;
    appendFileSync(exclude, addition);
    content += addition;
  }
}

function setupFailure(
  ctx: WorktreeContext,
  destination: string,
  step: string,
  error: unknown,
  branch?: string,
): Error {
  const quoted = `'${destination.replaceAll("'", "'\\''")}'`;
  return new Error(
    `Worktree setup failed during ${step}: ${errorMessage(error)}\n` +
      `Retained worktree ${destination}${branch === undefined ? " and its Git state" : ` and branch ${branch}`}. ` +
      `Inspect and repair the failed step manually, then retry with \`${ctx.forms.aligndev} worktree setup ${quoted}\`.` +
      (branch === undefined
        ? ""
        : ` Or remove it with \`${ctx.forms.aligndev} worktree remove ${quoted}\` after preserving any work.`) +
      " No rollback was attempted.",
  );
}
