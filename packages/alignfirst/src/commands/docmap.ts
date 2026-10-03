import { main as docmapMain } from "@alignfirst/docmap";

import type { CommandContext } from "../context.js";
import { layoutOf } from "../project-layout.js";

export function runDocmap(ctx: CommandContext, args: string[]): number {
  const docs = layoutOf(ctx).locations.docs;
  const rootArgs = docs.in === "companion" && !args.includes("--root") ? ["--root", docs.path] : [];
  return docmapMain({
    argv: ["node", "docmap", ...rootArgs, ...args],
    cwd: ctx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    commands: { base: `${ctx.form} docmap`, withArgs: `${ctx.form} docmap` },
  });
}
