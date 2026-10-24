import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import type { CommandContext } from "../context.js";
import { CliError } from "../cli-error.js";
import { errorMessage } from "../errors.js";
import {
  git,
  gitNetwork,
  gitOutput,
  gitOutputOrUndefined,
  gitOutputRaw,
  gitQuiet,
  gitSucceeds,
} from "../git.js";
import { parseCommandArgs } from "../parse-args.js";
import { archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { resolvePlansMode } from "../plans/mode.js";
import { capturePendingWrites, restorePendingWrites } from "../plans/pending-writes.js";
import {
  findStoppedRebase,
  rebaseInProgress,
  renderStoppedRebase,
  resolveStoppedRebase,
} from "../plans/rebase.js";
import { acquireSyncLock } from "../plans/sync-lock.js";
import { layoutOf } from "../project-layout.js";

const DEFAULT_SYNC_RETRY_BUDGET_MS = 30_000;

export async function runSync(ctx: CommandContext, args: string[]): Promise<number> {
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
  const layout = layoutOf(ctx);
  const mode = resolvePlansMode(ctx.cwd, layout.locations[".plans"], ctx.form, ctx.home);
  if (mode.kind === "local") {
    if (thresholdDays !== undefined) autoArchive(layout, thresholdDays, ctx.stdout);
    ctx.stdout.write("(local mode, nothing to sync)\n");
    return 0;
  }
  const deadline = Date.now() + syncRetryBudgetMs(ctx.env);
  while (true) {
    const result = await runAttempt(ctx, mode.repoToplevel, thresholdDays);
    if (result.kind === "done") {
      ctx.stdout.write(
        `Work files synchronized: ${result.sent ? "local changes sent" : "nothing to send"}.\n`,
      );
      return 0;
    }
    if (Date.now() >= deadline) throw exhaustedError(result);
    await sleep(250 + Math.floor(Math.random() * 2251));
  }
}

function syncRetryBudgetMs(env: NodeJS.ProcessEnv): number {
  const value = env.ALIGNFIRST_SYNC_RETRY_MS;
  if (value === undefined) return DEFAULT_SYNC_RETRY_BUDGET_MS;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0)
    throw new CliError("ALIGNFIRST_SYNC_RETRY_MS must be a non-negative number of milliseconds.");
  return budget;
}

function exhaustedError(result: Exclude<AttemptResult, { kind: "done" }>): CliError {
  if (result.kind === "lockBusy")
    return new CliError(
      `Work-files sync lock is busy: ${result.path} (pid ${result.pid ?? "unknown"}). Retry, or remove the lock directory when that process is gone.`,
    );
  if (result.kind === "treeChanged")
    return new CliError(
      "Work files could not be synchronized: they kept changing during synchronization. Retry later." +
        (result.output === "" ? "" : `\n${result.output}`),
    );
  return new CliError(
    "Work files could not be synchronized: another sync kept landing first. Retry later.",
  );
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

type AttemptResult =
  | { kind: "done"; sent: boolean }
  | { kind: "lockBusy"; path: string; pid: number | undefined }
  | { kind: "remoteAdvanced" }
  | { kind: "treeChanged"; output: string };

async function runAttempt(
  ctx: CommandContext,
  repoDir: string,
  thresholdDays: number | undefined,
): Promise<AttemptResult> {
  const lock = acquireSyncLock(repoDir);
  if (lock.kind === "busy") return { kind: "lockBusy", path: lock.path, pid: lock.pid };
  try {
    assertNoStoppedRebase(repoDir, ctx.form);
    const upstream = hasUpstream(repoDir);
    if (upstream) await gitNetwork(ctx, repoDir, ["fetch", "--quiet"]);
    await snapshot(ctx, repoDir);
    if (upstream) {
      await consolidateSyncCommits(ctx, repoDir);
      const result = await integrate(ctx, repoDir);
      if (result.kind === "treeChanged") return result;
    }
    if (thresholdDays !== undefined && autoArchive(layoutOf(ctx), thresholdDays, ctx.stdout))
      await snapshot(ctx, repoDir);
    if (!hasCommitsToSend(repoDir)) return { kind: "done", sent: false };
    return await push(ctx, repoDir);
  } finally {
    lock.release();
  }
}

// A running session log is named `*.running.md` by aligndev and renamed when its run ends, so Git
// itself leaves it out of the snapshot, however late it appears.
async function snapshot(ctx: CommandContext, repoDir: string): Promise<void> {
  await git(ctx, repoDir, "add", "-A", "--", ".", ":(exclude,glob)**/_aligndev/*.running.md");
  if (hasStagedChanges(repoDir)) await git(ctx, repoDir, "commit", "--quiet", "-m", "sync");
}

async function consolidateSyncCommits(ctx: CommandContext, repoDir: string): Promise<void> {
  const base = gitOutputOrUndefined(repoDir, "merge-base", "@{u}", "HEAD");
  if (base === undefined) return;
  const commits = gitOutputRaw(repoDir, "log", "--format=%H%x1f%P%x1f%B%x1e", `${base}..HEAD`)
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "");
  if (
    commits.length === 0 ||
    commits.some((record) => {
      const [, parents, body] = record.split("\x1f");
      return parents.split(" ").length > 1 || body.trim() !== "sync";
    })
  )
    return;
  await git(ctx, repoDir, "reset", "--soft", base);
  if (hasStagedChanges(repoDir)) await git(ctx, repoDir, "commit", "--quiet", "-m", "sync");
}

type IntegrationResult = { kind: "integrated" } | { kind: "treeChanged"; output: string };

async function integrate(ctx: CommandContext, repoDir: string): Promise<IntegrationResult> {
  if (gitSucceeds(repoDir, "merge-base", "--is-ancestor", "@{u}", "HEAD"))
    return { kind: "integrated" };
  const output = await gitQuiet(repoDir, ["-c", "rebase.autoStash=false", "rebase", "@{u}"]);
  if (output === undefined) return { kind: "integrated" };
  if (!rebaseInProgress(repoDir)) return { kind: "treeChanged", output };
  if (await abortForPendingWrites(ctx, repoDir)) return { kind: "treeChanged", output };
  try {
    await resolveStoppedRebase(ctx, repoDir);
    return { kind: "integrated" };
  } catch (resolutionError) {
    if (await abortForPendingWrites(ctx, repoDir)) return { kind: "treeChanged", output };
    try {
      await git(ctx, repoDir, "rebase", "--abort");
    } catch (abortError) {
      throw new CliError(
        `${errorMessage(resolutionError)}\nAborting the rebase also failed: ${errorMessage(abortError)}`,
      );
    }
    throw new CliError(
      `${errorMessage(resolutionError)}\nThe work-files repository is back to its state before the pull. Resolve the conflict by hand in ${repoDir}: git pull --rebase, then ${ctx.form} sync.`,
    );
  }
}

async function abortForPendingWrites(ctx: CommandContext, repoDir: string): Promise<boolean> {
  // Check conflicts without decoding names, so unsupported names still reach the resolution error.
  if (!rebaseInProgress(repoDir) || !gitSucceeds(repoDir, "diff", "--quiet", "--diff-filter=U"))
    return false;
  const writes = capturePendingWrites(repoDir);
  if (writes.length === 0) return false;
  await git(ctx, repoDir, "rebase", "--abort");
  restorePendingWrites(repoDir, writes);
  return true;
}

async function push(ctx: CommandContext, repoDir: string): Promise<AttemptResult> {
  try {
    await gitNetwork(ctx, repoDir, ["push", "--quiet", "-u", "origin", "HEAD"]);
    return { kind: "done", sent: true };
  } catch {
    await gitNetwork(ctx, repoDir, ["fetch", "--quiet"]);
    if (
      hasUpstream(repoDir) &&
      !gitSucceeds(repoDir, "merge-base", "--is-ancestor", "@{u}", "HEAD")
    )
      return { kind: "remoteAdvanced" };
    throw new CliError("git push failed. See the git output above.");
  }
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
