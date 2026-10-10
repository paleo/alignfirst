import { parseArgs } from "node:util";
import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import { registerCompanion, unregisterCompanion } from "../project-layout.js";

const HELP_OPTION = { help: { type: "boolean", short: "h", default: false } } as const;

export function runCompanion(ctx: CommandContext, args: string[]): number {
  const [command, ...rest] = args;
  switch (command) {
    case "register":
      return runRegister(ctx, rest);
    case "unregister":
      return runUnregister(ctx, rest);
    case "--help":
    case "-h":
      ctx.stdout.write(companionUsage(ctx));
      return 0;
    default:
      throw new CliError(`Unknown or missing companion command.\n\n${companionUsage(ctx)}`);
  }
}

function companionUsage(ctx: CommandContext): string {
  return `Usage:
  ${ctx.form} companion register [--create-dir]
  ${ctx.form} companion unregister [--remove-dir [--force]]
`;
}

function runRegister(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} companion register [--create-dir]

Registers the current project in ~/.alignfirst/companions/registry.json, with every item on
"auto". A registered project keeps its registration. Fails when another key uses the same
companion directory.

Options:
  --create-dir  Create the companion directory when it is missing. Without it, the commands
                that write an item there create it.
`;
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: { "create-dir": { type: "boolean", default: false }, ...HELP_OPTION },
      strict: true,
    } as const),
  );
  if (printedHelp(ctx, values.help, usage)) return 0;
  const registration = registerCompanion(ctx.cwd, ctx.home, { createDir: values["create-dir"] });
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

function runUnregister(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} companion unregister [--remove-dir [--force]]

Removes the current project from ~/.alignfirst/companions/registry.json. Keeps its companion
directory, unless --remove-dir.

Options:
  --remove-dir  Also remove the companion directory. Fails, with no change, when it is not
                empty or another key uses it.
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
  const removal = unregisterCompanion(ctx.cwd, ctx.home, { removeDir, force });
  ctx.stdout.write(`Unregistered ${removal.key} from ${removal.registry}.\n`);
  if (removal.removed) ctx.stdout.write(`Removed companion directory: ${removal.dir}\n`);
  else if (removal.empty !== undefined)
    ctx.stdout.write(
      `Orphaned companion directory: ${removal.dir}${removal.empty ? " (empty)" : ""}\n`,
    );
  return 0;
}

function printedHelp(ctx: CommandContext, help: boolean, usage: string): boolean {
  if (help) ctx.stdout.write(usage);
  return help;
}
