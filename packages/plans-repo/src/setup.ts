import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { CliError, type CliContext } from "./context.js";
import { git, gitOutput } from "./git.js";

export function runSetup(ctx: CliContext, args: string[]): void {
  const options = parseSetupArgs(args);
  checkMainWorktreeRoot(ctx);
  const cloneDir = resolve(ctx.cwd, options.dir);
  ensureClone(ctx, cloneDir, options.repoUrl);
  const projectDir = join(cloneDir, options.folder);
  mkdirSync(projectDir, { recursive: true });
  linkPlans(ctx, projectDir);
}

interface SetupOptions {
  dir: string;
  repoUrl: string;
  folder: string;
}

function parseSetupArgs(args: string[]): SetupOptions {
  let dir: string | undefined;
  let repoUrl: string | undefined;
  let folder: string | undefined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === "--repo") repoUrl = args[++i];
    else if (arg === "--folder") folder = args[++i];
    else if (arg.startsWith("-")) throw new CliError(`Unknown option: ${arg}`);
    else if (dir === undefined) dir = arg;
    else throw new CliError(`Unexpected argument: ${arg}`);
  }
  if (dir === undefined || repoUrl === undefined || folder === undefined)
    throw new CliError("Usage: plans-repo setup <dir> --repo <url> --folder <name>");
  return { dir, repoUrl, folder };
}

function checkMainWorktreeRoot(ctx: CliContext): void {
  const toplevel = gitOutput(ctx.cwd, "rev-parse", "--show-toplevel");
  if (realpathSync(toplevel) !== realpathSync(ctx.cwd))
    throw new CliError("Run this command from the repository root.");
  const gitDir = gitOutput(ctx.cwd, "rev-parse", "--absolute-git-dir");
  const commonDir = gitOutput(ctx.cwd, "rev-parse", "--git-common-dir");
  if (realpathSync(gitDir) !== realpathSync(resolve(ctx.cwd, commonDir)))
    throw new CliError(
      "Run this command from the main worktree. Linked worktrees reach .plans through it.",
    );
}

function ensureClone(ctx: CliContext, cloneDir: string, repoUrl: string): void {
  if (existsSync(join(cloneDir, ".git"))) {
    const origin = gitOutput(cloneDir, "remote", "get-url", "origin");
    if (normalizeGitUrl(origin) !== normalizeGitUrl(repoUrl))
      throw new CliError(`${cloneDir} is a clone of ${origin}, expected ${repoUrl}.`);
    ctx.stdout.write(`Using the existing clone at ${cloneDir}.\n`);
    return;
  }
  if (existsSync(cloneDir) && readdirSync(cloneDir).length > 0)
    throw new CliError(`${cloneDir} exists and is not a git clone.`);
  git(ctx.cwd, "clone", "--quiet", repoUrl, cloneDir);
  ctx.stdout.write(`Cloned ${repoUrl} into ${cloneDir}.\n`);
}

function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function linkPlans(ctx: CliContext, projectDir: string): void {
  const plansPath = join(ctx.cwd, ".plans");
  const stats = lstatSync(plansPath, { throwIfNoEntry: false });
  if (stats?.isSymbolicLink()) {
    if (existsSync(plansPath) && realpathSync(plansPath) === realpathSync(projectDir)) {
      ctx.stdout.write(".plans already links to the plans repository.\n");
      return;
    }
    rmSync(plansPath);
  } else if (stats?.isDirectory()) {
    migratePlansContent(ctx, plansPath, projectDir);
  } else if (stats) {
    throw new CliError(".plans exists and is not a directory.");
  }
  const target = relative(ctx.cwd, projectDir);
  symlinkSync(target, plansPath);
  ctx.stdout.write(`Linked .plans → ${target}\n`);
  ctx.stdout.write(`Publish with: ${ctx.syncCommand}\n`);
}

function migratePlansContent(ctx: CliContext, plansPath: string, projectDir: string): void {
  const entries = readdirSync(plansPath);
  for (const entry of entries) {
    const dest = join(projectDir, entry);
    if (existsSync(dest))
      throw new CliError(
        `Cannot migrate .plans/${entry}: ${dest} already exists. Merge it manually, then re-run.`,
      );
    cpSync(join(plansPath, entry), dest, { recursive: true });
  }
  rmSync(plansPath, { recursive: true });
  if (entries.length > 0)
    ctx.stdout.write(`Migrated ${entries.length} entries from the local .plans directory.\n`);
}
