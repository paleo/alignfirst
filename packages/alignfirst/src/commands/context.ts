import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderCommandForm } from "../command-form.js";
import type { CommandContext } from "../context.js";
import { renderConventionsSection } from "../conventions.js";
import { readInstructions } from "../instructions.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { layoutOf } from "../project-layout.js";
import { runDocmap } from "./docmap.js";

export function runContext(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} context\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  ctx.stdout.write(renderConventionsSection(ctx));
  writeProjectInstructions(ctx);
  const code = layoutOf(ctx).locations.docs.exists ? writeDocmapSection(ctx) : 0;
  ctx.stdout.write(`\n${renderProtocolsSection(ctx)}`);
  return code;
}

function writeProjectInstructions(ctx: CommandContext): void {
  const path = join(layoutOf(ctx).locations[".alignfirst-instructions"].path, "context.md");
  if (!existsSync(path)) return;
  const content = readInstructions(path).trim();
  if (content === "") return;
  ctx.stdout.write(`\n# Project Instructions\n\n${content}\n`);
}

function writeDocmapSection(ctx: CommandContext): number {
  ctx.stdout.write("\n# Docmap Usage\n\n");
  return runDocmap(ctx, []);
}

function renderProtocolsSection(ctx: CommandContext): string {
  const template = readFileSync(
    new URL("../../templates/context/protocols.md", import.meta.url),
    "utf-8",
  );
  return renderCommandForm(template, ctx.form);
}
