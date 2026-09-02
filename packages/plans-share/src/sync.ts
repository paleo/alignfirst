import { join } from "node:path";
import { archiveThresholdDays, autoArchive } from "./archive.js";
import { CliError, type CliContext } from "./context.js";
import { git, gitOutput, gitSucceeds } from "./git.js";
import { resolvePlansMode } from "./plans-path.js";

export function runSync(ctx: CliContext, args: string[]): void {
  const options = parseSyncArgs(args);
  const thresholdDays = options.autoArchive ? archiveThresholdDays() : undefined;
  const mode = resolvePlansMode(ctx);
  const plansDir = join(ctx.cwd, ".plans");
  if (mode.kind === "local") {
    if (thresholdDays !== undefined) autoArchive(plansDir, thresholdDays, ctx.stdout);
    ctx.stdout.write("(local plans mode, nothing to sync)\n");
    return;
  }
  const repoDir = mode.repoToplevel;
  // A fresh clone of an empty plans repository has no HEAD yet: nothing to rebase onto.
  if (hasHead(repoDir)) git(repoDir, "pull", "--rebase", "--autostash");
  if (thresholdDays !== undefined) autoArchive(plansDir, thresholdDays, ctx.stdout);
  git(repoDir, "add", "-A");
  if (hasStagedChanges(repoDir)) git(repoDir, "commit", "--quiet", "-m", "sync");
  // Still no HEAD after the commit step: an empty clone with nothing staged, nothing to push.
  if (hasHead(repoDir) && hasCommitsToSend(repoDir)) {
    git(repoDir, "push", "--quiet", "-u", "origin", "HEAD");
    ctx.stdout.write("Plans synchronized: local changes sent.\n");
  } else {
    ctx.stdout.write("Plans synchronized: nothing to send.\n");
  }
}

interface SyncOptions {
  autoArchive: boolean;
}

function parseSyncArgs(args: string[]): SyncOptions {
  let autoArchive = false;
  for (const arg of args) {
    if (arg === "--auto-archive") autoArchive = true;
    else throw new CliError(`Unknown option: ${arg}`);
  }
  return { autoArchive };
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
