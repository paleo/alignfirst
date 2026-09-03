import { existsSync } from "node:fs";
import { join } from "node:path";

import { main as docmapMain } from "@paleo/docmap";

import type { CommandContext } from "../context.js";
import { resolveProjectFile } from "../overlay.js";

export function runDocmap(ctx: CommandContext, args: string[]): number {
  const docmapArgs = withOverlayRoot(ctx, args);
  return docmapMain({
    argv: ["node", "docmap", ...docmapArgs],
    cwd: ctx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    commands: { base: `${ctx.form} docmap`, withArgs: `${ctx.form} docmap` },
  });
}

function withOverlayRoot(ctx: CommandContext, args: string[]): string[] {
  if (args.includes("--root") || existsSync(join(ctx.cwd, "docs"))) return args;
  const docs = resolveProjectFile(ctx.cwd, ctx.overlay, "docs");
  if (docs?.source !== "overlay") return args;
  return [...args, "--root", docs.path];
}
