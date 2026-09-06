import type { CommandContext } from "../context.js";
import { renderConventions } from "../conventions.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { runDocmap } from "./docmap.js";

export function runContext(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} context\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  ctx.stdout.write(renderConventions(ctx));
  ctx.stdout.write("\n");
  return runDocmap(ctx, []);
}
