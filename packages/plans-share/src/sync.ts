import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { CliError, type CliContext } from "./context.js";
import { git, gitOutput, gitSucceeds } from "./git.js";
import { checkPlansIsDirectory, plansRepoToplevel } from "./plans-path.js";

export function runSync(ctx: CliContext): void {
  const plansDir = resolvePlansDir(ctx);
  // A fresh clone of an empty plans repository has no HEAD yet: nothing to rebase onto.
  if (hasHead(plansDir)) git(plansDir, "pull", "--rebase", "--autostash");
  git(plansDir, "add", "-A");
  if (hasStagedChanges(plansDir)) git(plansDir, "commit", "--quiet", "-m", "sync");
  // Still no HEAD after the commit step: an empty clone with nothing staged, nothing to push.
  if (hasHead(plansDir) && hasCommitsToSend(plansDir)) {
    git(plansDir, "push", "--quiet", "-u", "origin", "HEAD");
    ctx.stdout.write("Plans synchronized: local changes sent.\n");
  } else {
    ctx.stdout.write("Plans synchronized: nothing to send.\n");
  }
}

function resolvePlansDir(ctx: CliContext): string {
  const plansPath = join(ctx.cwd, ".plans");
  if (!existsSync(plansPath)) {
    if (isBrokenSymlink(plansPath))
      throw new CliError(
        "The .plans symlink is broken. Re-run the plans:setup script with the clone location.",
      );
    throw new CliError("No .plans directory here. Run this command from a worktree root.");
  }
  checkPlansIsDirectory(plansPath);
  const plansToplevel = plansRepoToplevel(plansPath);
  const repoToplevel = gitOutput(ctx.cwd, "rev-parse", "--show-toplevel");
  if (plansToplevel === repoToplevel)
    throw new CliError(
      ".plans is not linked to a team plans repository. Run the plans:setup script first.",
    );
  return plansToplevel;
}

function isBrokenSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function hasHead(dir: string): boolean {
  return gitSucceeds(dir, "rev-parse", "--verify", "-q", "HEAD");
}

function hasStagedChanges(dir: string): boolean {
  return !gitSucceeds(dir, "diff", "--cached", "--quiet");
}

// No upstream yet means the branch was never pushed: everything is to send.
function hasCommitsToSend(dir: string): boolean {
  if (!gitSucceeds(dir, "rev-parse", "--verify", "-q", "@{u}")) return true;
  return gitOutput(dir, "rev-list", "--count", "@{u}..HEAD") !== "0";
}
