import { main as docmapMain } from "@paleo/docmap";

import type { CommandContext } from "../context.js";

export function runDocmap(ctx: CommandContext, args: string[]): number {
  return docmapMain({
    argv: ["node", "docmap", ...args],
    cwd: ctx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    commands: { base: `${ctx.form} docmap`, withArgs: `${ctx.form} docmap` },
  });
}
