import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { addCompanion } from "../project-layout.js";

export function runCompanion(ctx: CommandContext, args: string[]): number {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return runAdd(ctx, rest);
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
`;
}

function runAdd(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} companion add

Registers the current project in ~/.alignfirst/companions/registry.json, with every item on
"auto", and creates its companion directory. A project that a key already matches stays as is.
`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const registration = addCompanion(ctx.cwd, ctx.home);
  ctx.stdout.write(
    registration.added
      ? `Registered ${registration.key} in ${registration.registry}.\n`
      : `Already registered by ${registration.key} in ${registration.registry}.\n`,
  );
  ctx.stdout.write(`Companion: ${registration.dir}\n`);
  return 0;
}
