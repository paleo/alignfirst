import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import { renderCommandForm } from "../command-form.js";
import type { CommandContext } from "../context.js";
import { renderConventions } from "../conventions.js";
import { errorMessage } from "../errors.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { layoutOf } from "../project-layout.js";
import { runDocmap } from "./docmap.js";

export function runContext(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} context\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  ctx.stdout.write(`# Project Conventions\n\n${renderConventions(ctx)}`);
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

function readInstructions(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${errorMessage(error)}`);
  }
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
