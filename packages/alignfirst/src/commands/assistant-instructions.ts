import type { CommandContext } from "../context.js";
import { renderConventionsSection } from "../conventions.js";
import { readInstructions } from "../instructions.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { layoutOf } from "../project-layout.js";
import { renderWorkspaceGuidance } from "../workspace-guidance.js";

export function runAssistantInstructions(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} assistant-instructions\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const location = layoutOf(ctx).locations.assistantInstructionsFile;
  const content = location === null ? undefined : readInstructions(location.path);
  ctx.stdout.write(renderConventionsSection(ctx));
  ctx.stdout.write(`\n${renderWorkspaceGuidance(ctx)}`);
  if (location !== null && content !== undefined) {
    ctx.stdout.write(`\n# Assistant Instructions\n\nSource: ${location.path}\n\n${content}`);
  }
  return 0;
}
