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
import { gitOutput } from "./git.js";

export function runSetup(ctx: CliContext, args: string[]): void {
  const options = parseSetupArgs(args);
  checkMainWorktreeRoot(ctx);
  const cloneDir = resolve(ctx.cwd, options.dir);
  checkClone(ctx, cloneDir);
  const projectDir = join(cloneDir, options.folder);
  mkdirSync(projectDir, { recursive: true });
  linkPlans(ctx, projectDir);
}

interface SetupOptions {
  dir: string;
  folder: string;
}

function parseSetupArgs(args: string[]): SetupOptions {
  let dir: string | undefined;
  let folder: string | undefined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === "--folder") folder = args[++i];
    else if (arg.startsWith("-")) throw new CliError(`Unknown option: ${arg}`);
    else if (dir === undefined) dir = arg;
    else throw new CliError(`Unexpected argument: ${arg}`);
  }
  if (dir === undefined || folder === undefined)
    throw new CliError("Usage: plans-repo setup <dir> --folder <name>");
  return { dir, folder };
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

function checkClone(ctx: CliContext, cloneDir: string): void {
  if (!existsSync(cloneDir))
    throw new CliError(
      `${cloneDir} does not exist. Clone the team plans repository there first (see the instruction file).`,
    );
  if (!existsSync(join(cloneDir, ".git")))
    throw new CliError(
      `${cloneDir} is not a git repository. Point plans:setup at a clone of the team plans repository.`,
    );
  if (realpathSync(cloneDir) === realpathSync(ctx.cwd))
    throw new CliError(
      `${cloneDir} is the product repository itself. Point plans:setup at a clone of the team plans repository.`,
    );
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
  const collisions = entries.filter((entry) => existsSync(join(projectDir, entry)));
  if (collisions.length > 0)
    throw new CliError(
      `Cannot migrate .plans: already in ${projectDir}: ${collisions.join(", ")}. ` +
        "Merge them manually, then re-run.",
    );
  for (const entry of entries)
    cpSync(join(plansPath, entry), join(projectDir, entry), { recursive: true });
  rmSync(plansPath, { recursive: true });
  if (entries.length > 0)
    ctx.stdout.write(`Migrated ${entries.length} entries from the local .plans directory.\n`);
}
