import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { resolveProjectFile } from "../overlay.js";
import { parseCommandArgs } from "../parse-args.js";

export function runDevelopers(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} DEVELOPERS.md\n`;
  if (parseDevelopersArgs(ctx, args, usage)) return 0;
  const file = resolveProjectFile(ctx.cwd, ctx.overlay, "DEVELOPERS.md");
  if (file === undefined) throw missingDevelopersError(ctx);
  ctx.stdout.write(readFileSync(file.path, "utf-8"));
  return 0;
}

function parseDevelopersArgs(ctx: CommandContext, args: string[], usage: string): boolean {
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

function missingDevelopersError(ctx: CommandContext): CliError {
  const tried = [join(ctx.cwd, "DEVELOPERS.md")];
  if (ctx.overlay !== undefined) tried.push(join(ctx.overlay.dir, "DEVELOPERS.md"));
  return new CliError(`No DEVELOPERS.md found. Tried: ${tried.join(", ")}.`);
}
