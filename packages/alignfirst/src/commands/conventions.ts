import type { CommandContext } from "../context.js";
import { renderConventions } from "../conventions.js";
import { parseBareCommandArgs } from "../parse-args.js";

export function runConventions(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} conventions\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  ctx.stdout.write(renderConventions(ctx));
  return 0;
}
