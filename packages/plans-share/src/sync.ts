import type { CliContext } from "./context.js";
import { git, gitOutput, gitSucceeds } from "./git.js";
import { resolvePlansMode } from "./plans-path.js";

export function runSync(ctx: CliContext): void {
  const mode = resolvePlansMode(ctx);
  if (mode.kind === "local") {
    ctx.stdout.write("(local plans mode, nothing to sync)\n");
    return;
  }
  const plansDir = mode.repoToplevel;
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
