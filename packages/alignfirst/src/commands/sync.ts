import { closeSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  gitSucceeds,
  GitTimeoutError,
} from "../git.js";
import { parseCommandArgs } from "../parse-args.js";
import { archiveThresholdDays, autoArchive } from "../plans/archive.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findStoppedRebase, renderStoppedRebase, resolveStoppedRebase } from "../plans/rebase.js";
import { acquireSyncLock } from "../plans/sync-lock.js";
import { layoutOf } from "../project-layout.js";

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
  for (let attempt = 0; attempt < 3; ++attempt) {
    const result = await runAttempt(ctx, mode.repoToplevel, thresholdDays);
    if (result.kind === "done") {
      ctx.stdout.write(
        `Work files synchronized: ${result.sent ? "local changes sent" : "nothing to send"}.\n`,
      );
      return 0;
    }
    if (attempt === 2) {
      if (result.kind === "lockBusy")
        throw new CliError(
          `Work-files sync lock is busy: ${result.path} (pid ${result.pid ?? "unknown"}). Retry, or remove the lock directory when that process is gone.`,
        );
      throw new CliError(
        "Work files could not be synchronized: another sync kept landing first. Retry later.",
      );
    }
    await sleep(250 + Math.floor(Math.random() * 2251));
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

type AttemptResult =
  | { kind: "done"; sent: boolean }
  | { kind: "lockBusy"; path: string; pid: number | undefined }
  | { kind: "remoteAdvanced" };

async function runAttempt(
  ctx: CommandContext,
  repoDir: string,
  thresholdDays: number | undefined,
): Promise<AttemptResult> {
  const lock = acquireSyncLock(repoDir);
  if (lock.kind === "busy") return { kind: "lockBusy", path: lock.path, pid: lock.pid };
  try {
    assertNoStoppedRebase(repoDir, ctx.form);
    await snapshot(ctx, repoDir);
    if (hasUpstream(repoDir)) {
      await consolidateSyncCommits(ctx, repoDir);
      await integrate(ctx, repoDir);
    }
    if (thresholdDays !== undefined && autoArchive(layoutOf(ctx), thresholdDays, ctx.stdout))
      await snapshot(ctx, repoDir);
    if (!hasCommitsToSend(repoDir)) return { kind: "done", sent: false };
    return await push(ctx, repoDir);
  } finally {
    lock.release();
  }
}

async function snapshot(ctx: CommandContext, repoDir: string): Promise<void> {
  const excluded = gitOutputRaw(repoDir, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter((path) => basename(dirname(path)) === "_aligndev" && path.endsWith(".md"))
    .filter((path) => isRunningLog(join(repoDir, path)));
  await git(
    ctx,
    repoDir,
    "add",
    "-A",
    "--",
    ".",
    ...excluded.map((path) => `:(literal,exclude)${path}`),
  );
  if (hasStagedChanges(repoDir)) await git(ctx, repoDir, "commit", "--quiet", "-m", "sync");
}

function isRunningLog(path: string): boolean {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const text = buffer.subarray(0, readSync(handle, buffer, 0, buffer.length, 0)).toString("utf8");
    if (!text.startsWith("---\n")) return false;
    const end = text.indexOf("\n---\n", 3);
    return end !== -1 && text.slice(4, end).split("\n").includes("status: running");
  } finally {
    closeSync(handle);
  }
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

async function integrate(ctx: CommandContext, repoDir: string): Promise<void> {
  try {
    await gitNetwork(ctx, repoDir, ["pull", "--rebase"]);
  } catch (error) {
    if (error instanceof GitTimeoutError || findStoppedRebase(repoDir) === undefined) throw error;
    try {
      await resolveStoppedRebase(ctx, repoDir);
    } catch (resolutionError) {
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
}

async function push(ctx: CommandContext, repoDir: string): Promise<AttemptResult> {
  try {
    await gitNetwork(ctx, repoDir, ["push", "--quiet", "-u", "origin", "HEAD"]);
    return { kind: "done", sent: true };
  } catch (error) {
    if (error instanceof GitTimeoutError) throw error;
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
