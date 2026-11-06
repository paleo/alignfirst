import { resolve } from "node:path";

import { main as docmapMain } from "@alignfirst/docmap";

import type { CommandContext } from "../context.js";
import { layoutOf } from "../project-layout.js";

export interface DocmapPresentation {
  showRootCommandInShortHelp?: boolean;
}

export function runDocmap(
  ctx: CommandContext,
  args: string[],
  presentation?: DocmapPresentation,
): number {
  const docs = layoutOf(ctx).locations.docs;
  const needsRoot = docs.in === "companion" || docs.path !== resolve(ctx.cwd, "docs");
  const rootArgs = needsRoot && !args.includes("--root") ? ["--root", docs.path] : [];
  return docmapMain({
    argv: ["node", "docmap", ...rootArgs, ...args],
    cwd: ctx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    commands: { base: `${ctx.form} docmap`, withArgs: `${ctx.form} docmap` },
    showRootCommandInShortHelp: presentation?.showRootCommandInShortHelp,
  });
}
