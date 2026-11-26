import type { CommandContext } from "../context.js";
import { renderConventionsSection } from "../conventions.js";
import { readInstructions } from "../instructions.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { type ItemLocation, layoutOf } from "../project-layout.js";
import { renderWorkspaceGuidance } from "../workspace-guidance.js";

export function runAssistantInstructions(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} assistant-instructions\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  const layout = layoutOf(ctx);
  const location = layout.locations.assistantInstructionsFile;
  const explicit = layout.projectConfig?.config.assistantInstructionsFile !== undefined;
  const content = readGuide(location, explicit);
  ctx.stdout.write(renderConventionsSection(ctx));
  ctx.stdout.write(`\n${renderWorkspaceGuidance(ctx)}`);
  if (content !== undefined) ctx.stdout.write(`\n${renderGuideBlock(location, content)}`);
  return 0;
}

/** The trimmed guide, or `undefined` when a default file is missing or any file is blank. */
function readGuide(location: ItemLocation, explicit: boolean): string | undefined {
  if (!explicit && !location.exists) return;
  const content = readInstructions(location.path).trimEnd();
  return content.length === 0 ? undefined : content;
}

function renderGuideBlock(location: ItemLocation, content: string): string {
  return [
    "# Project Assistant Instructions",
    "",
    `<assistant-instructions scope="project" file="${location.path}">`,
    content,
    "</assistant-instructions>",
    "",
  ].join("\n");
}
