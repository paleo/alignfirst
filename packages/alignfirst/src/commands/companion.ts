import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { addCompanion, unregisterCompanion } from "../project-layout.js";

export function runCompanion(ctx: CommandContext, args: string[]): number {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return runAdd(ctx, rest);
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
  ${ctx.form} companion add
  ${ctx.form} companion unregister
`;
}

function runAdd(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} companion add

Registers the current project in ~/.alignfirst/companions/registry.json, with every item on
"auto". A registered project keeps its registration. Creates the companion
directory when it is missing.
`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const registration = addCompanion(ctx.cwd, ctx.home);
  ctx.stdout.write(
    registration.added
      ? `Registered ${registration.key} in ${registration.registry}.\n`
      : `Already registered by ${registration.key} in ${registration.registry}.\n`,
  );
  ctx.stdout.write(`Companion: ${registration.dir}${registration.created ? " (created)" : ""}\n`);
  ctx.stdout.write(`Next: write the items at the paths \`${ctx.form} config\` reports.\n`);
  return 0;
}

function runUnregister(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} companion unregister

Removes the current project from ~/.alignfirst/companions/registry.json. Keeps its companion
directory.
`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const removal = unregisterCompanion(ctx.cwd, ctx.home);
  ctx.stdout.write(`Unregistered ${removal.key} from ${removal.registry}.\n`);
  if (removal.empty !== undefined)
    ctx.stdout.write(
      `Orphaned companion directory: ${removal.dir}${removal.empty ? " (empty)" : ""}\n`,
    );
  return 0;
}
