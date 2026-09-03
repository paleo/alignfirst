import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { gitOutput } from "../git.js";
import { parseCommandArgs } from "../parse-args.js";
import { archiveEntry, archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { resolvePlansMode } from "../plans/mode.js";

export function runPlans(ctx: CommandContext, args: string[]): number {
  const [command, ...rest] = args;
  switch (command) {
    case "setup":
      return runSetup(ctx, rest);
    case "check":
      return runCheck(ctx, rest);
    case "archive":
      return runArchive(ctx, rest);
    case "auto-archive":
      return runAutoArchive(ctx, rest);
    case "--help":
    case "-h":
      ctx.stdout.write(plansUsage(ctx));
      return 0;
    default:
      throw new CliError(`Unknown or missing plans command.\n\n${plansUsage(ctx)}`);
  }
}

function plansUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} plans setup <clone-dir> [--folder <name>]
  ${ctx.form} plans check
  ${ctx.form} plans archive <ticket-id | path>
  ${ctx.form} plans auto-archive
`;
}

function runSetup(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans setup <clone-dir> [--folder <name>]\n`;
  const parsed = parseSetupArgs(ctx, args, usage);
  if (parsed === undefined) return 0;
  checkMainWorktreeRoot(ctx);
  const cloneDir = resolve(ctx.cwd, parsed.dir);
  checkClone(ctx, cloneDir);
  const projectDir = join(cloneDir, parsed.folder);
  mkdirSync(projectDir, { recursive: true });
  linkPlans(ctx, projectDir);
  return 0;
}

interface SetupOptions {
  dir: string;
  folder: string;
}

function parseSetupArgs(
  ctx: CommandContext,
  args: string[],
  usage: string,
): SetupOptions | undefined {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        folder: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (positionals.length !== 1) throw new CliError(usage.trimEnd());
  const configFolder = ctx.projectConfig?.config.plans?.folder;
  if (values.folder !== undefined && configFolder !== undefined)
    throw new CliError(".alignfirst.json already sets plans.folder; drop --folder.");
  const folder = values.folder ?? configFolder;
  if (folder === undefined)
    throw new CliError("Pass --folder <name> or set plans.folder in .alignfirst.json.");
  return { dir: positionals[0], folder };
}

function checkMainWorktreeRoot(ctx: CommandContext): void {
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

function checkClone(ctx: CommandContext, cloneDir: string): void {
  if (!existsSync(cloneDir))
    throw new CliError(
      `${cloneDir} does not exist. Clone the team plans repository there first (see the instruction file).`,
    );
  if (!existsSync(join(cloneDir, ".git")))
    throw new CliError(
      `${cloneDir} is not a git repository. Point ${ctx.form} plans setup at a clone of the team plans repository.`,
    );
  if (realpathSync(cloneDir) === realpathSync(ctx.cwd))
    throw new CliError(
      `${cloneDir} is the product repository itself. Point ${ctx.form} plans setup at a clone of the team plans repository.`,
    );
}

function linkPlans(ctx: CommandContext, projectDir: string): void {
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
  ctx.stdout.write(`Publish with: ${ctx.form} sync\n`);
}

function migratePlansContent(ctx: CommandContext, plansPath: string, projectDir: string): void {
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

function runCheck(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans check\n`;
  if (handleBareHelp(ctx, args, usage)) return 0;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  if (mode.kind === "shared") ctx.stdout.write(".plans is linked to the team plans repository.\n");
  else
    ctx.stdout.write(
      ".plans is a local directory (local plans mode): synchronization is disabled.\n",
    );
  return 0;
}

function handleBareHelp(ctx: CommandContext, args: string[], usage: string): boolean {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: { help: { type: "boolean", short: "h", default: false } },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (positionals.length > 0)
    throw new CliError(`Unexpected argument: ${positionals[0]}\n\n${usage}`);
  if (!values.help) return false;
  ctx.stdout.write(usage);
  return true;
}

function runAutoArchive(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans auto-archive\n`;
  if (handleBareHelp(ctx, args, usage)) return 0;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  const archived = autoArchive(join(ctx.cwd, ".plans"), archiveThresholdDays(ctx.env), ctx.stdout);
  if (mode.kind === "shared" && archived) ctx.stdout.write(`Publish with: ${ctx.form} sync\n`);
  return 0;
}

function runArchive(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans archive <ticket-id | path>\n`;
  const target = resolveArchiveTarget(ctx, args, usage);
  if (target === undefined) return 0;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  const root = join(ctx.cwd, ".plans");
  archiveEntry(root, target, ctx.stdout);
  if (mode.kind === "shared") ctx.stdout.write(`Publish with: ${ctx.form} sync\n`);
  return 0;
}

function resolveArchiveTarget(
  ctx: CommandContext,
  args: string[],
  usage: string,
): string | undefined {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: { help: { type: "boolean", short: "h", default: false } },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (positionals.length !== 1) throw new CliError(usage.trimEnd());
  const argument = positionals[0];
  const plansDir = join(ctx.cwd, ".plans");
  const target = isPathArgument(argument) ? resolve(ctx.cwd, argument) : join(plansDir, argument);
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || realpathSync(dirname(target)) !== realpathSync(plansDir))
    throw new CliError(`${argument} must be an existing directory directly under .plans.`);
  if (basename(target).startsWith("_"))
    throw new CliError(`${argument}: names starting with _ are not tickets.`);
  return target;
}

function isPathArgument(argument: string): boolean {
  return argument.includes("/") || argument.includes("\\");
}
