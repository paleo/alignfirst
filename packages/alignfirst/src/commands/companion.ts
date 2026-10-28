import { parseArgs } from "node:util";
import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import { registerCompanion, unregisterCompanion } from "../project-layout.js";

const HELP_OPTION = { help: { type: "boolean", short: "h", default: false } } as const;

export async function runCompanion(ctx: CommandContext, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "register":
        return await runRegister(ctx, rest);
      case "unregister":
        return await runUnregister(ctx, rest);
      case "--help":
      case "-h":
        ctx.stdout.write(companionUsage(ctx));
        return 0;
      default:
        throw new CliError(`Unknown or missing companion command.\n\n${companionUsage(ctx)}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
}

function companionUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} companion register [--dir <path>] [--create-dir]
  ${ctx.form} companion unregister [--remove-dir [--force]]
`;
}

async function runRegister(ctx: CommandContext, args: string[]): Promise<number> {
  const usage = `Usage: ${ctx.form} companion register [--dir <path>] [--create-dir]

Registers the current project in ~/.alignfirst/companions/registry.json as { "dir": <path> },
with every item on "auto", preserving any profile selection. An existing companion is kept. Fails when the companion
directory is or contains ~/.alignfirst/companions or the home directory, or when it is, contains
or is inside the project or the companion directory of another key.

Options:
  --dir <path>  The companion directory, written as given: absolute, ~/..., or relative to
                ~/.alignfirst/companions (not to the current directory). Defaults to a name
                derived from the project path. On a registered project, fails when it differs
                from the registered directory.
  --create-dir  Create the companion directory when it is missing. Without it, the commands
                that write an item there create it.
`;
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        dir: { type: "string" },
        "create-dir": { type: "boolean", default: false },
        ...HELP_OPTION,
      },
      strict: true,
    } as const),
  );
  if (printedHelp(ctx, values.help, usage)) return 0;
  const registration = await registerCompanion(ctx.cwd, ctx.home, {
    dir: values.dir,
    createDir: values["create-dir"],
  });
  ctx.stdout.write(
    registration.added
      ? `Registered ${registration.key} in ${registration.registry}.\n`
      : `Already registered by ${registration.key} in ${registration.registry}.\n`,
  );
  const state = registration.created ? " (created)" : registration.exists ? "" : " (missing)";
  ctx.stdout.write(`Companion: ${registration.dir}${state}\n`);
  ctx.stdout.write(`Next: write the items at the paths \`${ctx.form} config\` reports.\n`);
  return 0;
}

async function runUnregister(ctx: CommandContext, args: string[]): Promise<number> {
  const usage = `Usage: ${ctx.form} companion unregister [--remove-dir [--force]]

Removes the companion fields from ~/.alignfirst/companions/registry.json, preserving any
profile selection. Keeps its companion directory, unless --remove-dir.

Options:
  --remove-dir  Also remove the companion directory when it is inside ~/.alignfirst/companions;
                keep it otherwise. Fails, with no change, when it is not empty, is or contains
                ~/.alignfirst/companions, or overlaps the project or another key's directory.
  --force       With --remove-dir, delete a non-empty companion directory.
`;
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        "remove-dir": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        ...HELP_OPTION,
      },
      strict: true,
    } as const),
  );
  if (printedHelp(ctx, values.help, usage)) return 0;
  const { "remove-dir": removeDir, force } = values;
  if (force && !removeDir) throw new CliError(`--force requires --remove-dir.\n\n${usage}`);
  const removal = await unregisterCompanion(ctx.cwd, ctx.home, { removeDir, force });
  ctx.stdout.write(`Unregistered ${removal.key} from ${removal.registry}.\n`);
  if (removal.aligndev !== null)
    ctx.stdout.write(
      `Kept profile-only entry: ${removal.aligndev.profile}. Remove the selection by editing the registry.\n`,
    );
  if (removal.removed) ctx.stdout.write(`Removed companion directory: ${removal.dir}\n`);
  else if (removal.empty !== undefined)
    ctx.stdout.write(
      `Orphaned companion directory: ${removal.dir}${removal.empty ? " (empty)" : ""}\n`,
    );
  for (const path of removal.retainedRuntimePaths)
    ctx.stdout.write(
      `Retained runtime: ${path}. Automatic discovery is being removed; preserve this path for manual cleanup.\n`,
    );
  if (removal.keptOutsideRoot)
    ctx.stdout.write("Kept: it is outside ~/.alignfirst/companions. Remove it by hand.\n");
  return 0;
}

function printedHelp(ctx: CommandContext, help: boolean, usage: string): boolean {
  if (help) ctx.stdout.write(usage);
  return help;
}
