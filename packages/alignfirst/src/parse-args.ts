import { CliError } from "./cli-error.js";
import type { CommandContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { parseArgs } from "node:util";

export function parseCommandArgs<T>(usage: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    const detail = errorMessage(error).split("\n", 1)[0];
    throw new CliError(`${detail}\n\n${usage}`);
  }
}

export function parseBareCommandArgs(ctx: CommandContext, args: string[], usage: string): boolean {
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
