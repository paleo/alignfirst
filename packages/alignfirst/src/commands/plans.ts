import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { assertMainWorktreeRoot } from "../git.js";
import { parseBareCommandArgs, parseCommandArgs } from "../parse-args.js";
import { archiveEntry, archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { linkPlans } from "../plans/link.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findStoppedRebase, renderStoppedRebase } from "../plans/rebase.js";

const RESERVED_PLANS_FOLDERS = new Set([".git", ".plans", "_archives", "_project"]);

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
  assertMainWorktreeRoot(ctx.cwd);
  const cloneDir = resolve(ctx.cwd, parsed.dir);
  checkClone(ctx, cloneDir);
  const projectDir = createPlansDirectory(cloneDir, parsed.folder);
  linkPlans(ctx, projectDir);
  return 0;
}

function createPlansDirectory(cloneDir: string, folder: string): string {
  if (folder.length === 0 || folder === "." || folder === ".." || /[\\/]/u.test(folder)) {
    throw new CliError(`Plans folder "${folder}" must be a single path segment.`);
  }
  if (RESERVED_PLANS_FOLDERS.has(folder.toLowerCase())) {
    throw new CliError(`Plans folder "${folder}" is reserved.`);
  }
  const cloneRoot = realpathSync(cloneDir);
  const projectDir = join(cloneRoot, folder);
  mkdirSync(projectDir, { recursive: true });
  const relativeTarget = relative(cloneRoot, realpathSync(projectDir));
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new CliError(`Plans folder "${folder}" must resolve inside ${cloneRoot}.`);
  }
  return projectDir;
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
  if (values.folder !== undefined && configFolder !== undefined && values.folder !== configFolder)
    throw new CliError(
      `--folder "${values.folder}" differs from plans.folder "${configFolder}" in .alignfirst.json.`,
    );
  const folder = values.folder ?? configFolder;
  if (folder === undefined)
    throw new CliError("Pass --folder <name> or set plans.folder in .alignfirst.json.");
  return { dir: positionals[0], folder };
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

function runCheck(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans check\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  if (mode.kind === "shared") {
    const stopped = findStoppedRebase(mode.repoToplevel);
    if (stopped !== undefined) throw new CliError(renderStoppedRebase(stopped, ctx.form));
  }
  if (mode.kind === "shared") ctx.stdout.write(".plans is linked to the team plans repository.\n");
  else
    ctx.stdout.write(
      ".plans is a local directory (local plans mode): synchronization is disabled.\n",
    );
  return 0;
}

function runAutoArchive(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} plans auto-archive\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
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
