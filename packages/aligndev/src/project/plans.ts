import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { runAlignfirst } from "../alignfirst-cli.js";
import type { CommandForms } from "../command-form.js";
import { errorMessage, isNodeError } from "../errors.js";
import { git, type GitContext, isInside, repositoryIdentity } from "../worktree/git.js";
import type { ProjectReport } from "./layout.js";

export interface PlansContext extends GitContext {
  alignfirstCommand: string[];
  forms: CommandForms;
}

export function validateEffectivePlans(
  ctx: PlansContext,
  report: ProjectReport,
  checkMode = false,
): string {
  const location = report.locations[".plans"];
  const prepare = `See \`${ctx.forms.aligndev} guide work-files-setup\` for authorized preparation.`;
  let target: string;
  try {
    if (!location.exists || !statSync(location.path).isDirectory()) throw new Error();
    target = realpathSync(location.path);
  } catch {
    throw new Error(`Error: no .plans/ directory usable at ${location.path}. ${prepare}`);
  }
  const identity = optionalRepositoryIdentity(ctx);
  if (identity !== undefined && isProjectTrackedDirectory(ctx, location.path, identity)) {
    throw new Error(
      `Effective .plans contains files tracked by this project's repository: ${location.path}. ${prepare}`,
    );
  }
  if (checkMode) {
    const result = runAlignfirst(ctx.alignfirstCommand, ["plans", "check"], ctx.cwd, ctx.env);
    if (result.status !== 0) {
      throw new Error(`Unusable .plans at ${location.path}: ${result.stderr.trim()}. ${prepare}`);
    }
  }
  return target;
}

function optionalRepositoryIdentity(ctx: GitContext): string | undefined {
  try {
    return repositoryIdentity(ctx);
  } catch (error) {
    if (
      errorMessage(error).includes("not a git repository") ||
      (isNodeError(error) && error.code === "ENOENT")
    )
      return;
    throw error;
  }
}

export function isProjectTrackedDirectory(
  ctx: GitContext,
  path: string,
  identity: string,
): boolean {
  const root = realpathSync(git(ctx, "rev-parse", "--show-toplevel").trim());
  const logicalPath = join(realpathSync(dirname(path)), basename(path));
  if (
    isInside(root, logicalPath) &&
    hasTrackedFiles({ ...ctx, cwd: root }, relative(root, logicalPath))
  )
    return true;
  const resolved = realpathSync(path);
  const source = { ...ctx, cwd: resolved };
  if (optionalRepositoryIdentity(source) !== identity) return false;
  const sourceRoot = git(source, "rev-parse", "--show-toplevel").trim();
  return hasTrackedFiles({ ...ctx, cwd: sourceRoot }, relative(sourceRoot, resolved));
}

function hasTrackedFiles(ctx: GitContext, path: string): boolean {
  return (
    git(ctx, "--literal-pathspecs", "ls-files", "-z", "--", path === "" ? "." : path).length > 0
  );
}
