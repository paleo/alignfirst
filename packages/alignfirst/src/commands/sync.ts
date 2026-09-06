import { join } from "node:path";
import { parseArgs } from "node:util";

import type { CommandContext } from "../context.js";
import { CliError } from "../cli-error.js";
import { git, gitOutput, gitSucceeds } from "../git.js";
import { parseCommandArgs } from "../parse-args.js";
import { archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findStoppedRebase, renderStoppedRebase } from "../plans/rebase.js";

export function runSync(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} sync [--auto-archive | --no-auto-archive]\n`;
  const options = parseSyncArgs(ctx, args, usage);
  if (options === undefined) return 0;
  const enabled =
    options.autoArchive === true
      ? true
      : options.noAutoArchive === true
        ? false
        : (ctx.projectConfig?.config.plans?.autoArchive ?? false);
  const thresholdDays = enabled ? archiveThresholdDays(ctx.env) : undefined;
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  const plansDir = join(ctx.cwd, ".plans");
  if (mode.kind === "local") {
    if (thresholdDays !== undefined) autoArchive(plansDir, thresholdDays, ctx.stdout);
    ctx.stdout.write("(local plans mode, nothing to sync)\n");
    return 0;
  }
  const repoDir = mode.repoToplevel;
  assertNoStoppedRebase(repoDir, ctx.form);
  git(repoDir, "add", "-A");
  if (hasStagedChanges(repoDir)) git(repoDir, "commit", "--quiet", "-m", "sync");
  if (hasUpstream(repoDir)) {
    try {
      git(repoDir, "pull", "--rebase");
    } catch {
      assertNoStoppedRebase(repoDir, ctx.form);
      throw new CliError("git pull failed. See the git output above.");
    }
  }
  if (thresholdDays !== undefined && autoArchive(plansDir, thresholdDays, ctx.stdout)) {
    git(repoDir, "add", "-A");
    if (hasStagedChanges(repoDir)) git(repoDir, "commit", "--quiet", "-m", "sync");
  }
  if (hasCommitsToSend(repoDir)) {
    try {
      git(repoDir, "push", "--quiet", "-u", "origin", "HEAD");
    } catch {
      throw new CliError(
        `git push failed. See the git output above. Another synchronization may have landed first: run ${ctx.form} sync again.`,
      );
    }
    ctx.stdout.write("Plans synchronized: local changes sent.\n");
  } else {
    ctx.stdout.write("Plans synchronized: nothing to send.\n");
  }
  return 0;
}

interface SyncOptions {
  autoArchive: boolean;
  noAutoArchive: boolean;
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
        "no-auto-archive": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (values["auto-archive"] && values["no-auto-archive"])
    throw new CliError(`--auto-archive and --no-auto-archive are mutually exclusive.\n\n${usage}`);
  return {
    autoArchive: values["auto-archive"],
    noAutoArchive: values["no-auto-archive"],
  };
}

function assertNoStoppedRebase(repoDir: string, form: string): void {
  const stopped = findStoppedRebase(repoDir);
  if (stopped !== undefined) throw new CliError(renderStoppedRebase(stopped, form));
}

function hasUpstream(dir: string): boolean {
  return gitSucceeds(dir, "rev-parse", "--verify", "-q", "@{u}");
}

function hasStagedChanges(dir: string): boolean {
  return !gitSucceeds(dir, "diff", "--cached", "--quiet");
}

function hasCommitsToSend(dir: string): boolean {
  if (!gitSucceeds(dir, "rev-parse", "--verify", "-q", "HEAD")) return false;
  if (!gitSucceeds(dir, "rev-parse", "--verify", "-q", "@{u}")) return true;
  return gitOutput(dir, "rev-list", "--count", "@{u}..HEAD") !== "0";
}
