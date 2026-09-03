import { join } from "node:path";
import { parseArgs } from "node:util";

import type { CommandContext } from "../context.js";
import { git, gitOutput, gitSucceeds } from "../git.js";
import { parseCommandArgs } from "../parse-args.js";
import { archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { resolvePlansMode } from "../plans/mode.js";

export function runSync(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} sync [--auto-archive]\n`;
  const options = parseSyncArgs(ctx, args, usage);
  if (options === undefined) return 0;
  const thresholdDays = options.autoArchive ? archiveThresholdDays(ctx.env) : undefined;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  const plansDir = join(ctx.cwd, ".plans");
  if (mode.kind === "local") {
    if (thresholdDays !== undefined) autoArchive(plansDir, thresholdDays, ctx.stdout);
    ctx.stdout.write("(local plans mode, nothing to sync)\n");
    return 0;
  }
  const repoDir = mode.repoToplevel;
  if (hasHead(repoDir)) git(repoDir, "pull", "--rebase", "--autostash");
  if (thresholdDays !== undefined) autoArchive(plansDir, thresholdDays, ctx.stdout);
  git(repoDir, "add", "-A");
  if (hasStagedChanges(repoDir)) git(repoDir, "commit", "--quiet", "-m", "sync");
  if (hasHead(repoDir) && hasCommitsToSend(repoDir)) {
    git(repoDir, "push", "--quiet", "-u", "origin", "HEAD");
    ctx.stdout.write("Plans synchronized: local changes sent.\n");
  } else {
    ctx.stdout.write("Plans synchronized: nothing to send.\n");
  }
  return 0;
}

interface SyncOptions {
  autoArchive: boolean;
}

function parseSyncArgs(
  ctx: CommandContext,
  args: string[],
  usage: string,
): SyncOptions | undefined {
  const { values } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        "auto-archive": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  return { autoArchive: values["auto-archive"] };
}

function hasHead(dir: string): boolean {
  return gitSucceeds(dir, "rev-parse", "--verify", "-q", "HEAD");
}

function hasStagedChanges(dir: string): boolean {
  return !gitSucceeds(dir, "diff", "--cached", "--quiet");
}

function hasCommitsToSend(dir: string): boolean {
  if (!gitSucceeds(dir, "rev-parse", "--verify", "-q", "@{u}")) return true;
  return gitOutput(dir, "rev-list", "--count", "@{u}..HEAD") !== "0";
}
