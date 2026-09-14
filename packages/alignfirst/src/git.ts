import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { CliError } from "./cli-error.js";
import type { Streams } from "./context.js";

export function git(streams: Streams, dir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.error !== undefined) throw gitFailure(args, result.error.message);
  streams.stdout.write(result.stdout);
  streams.stderr.write(result.stderr);
  if (result.status !== 0) throw gitFailure(args);
}

function gitFailure(args: string[], detail?: string): CliError {
  const output = detail?.trim();
  const subcommand = gitSubcommand(args);
  const label = subcommand === undefined ? "git command" : `git ${subcommand}`;
  if (output === undefined || output === "")
    return new CliError(`${label} failed. See the git output above.`);
  return new CliError(`${label} failed:\n${output}`);
}

function gitSubcommand(args: string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
}

export function assertMainWorktreeRoot(cwd: string): void {
  const toplevel = gitOutput(cwd, "rev-parse", "--show-toplevel");
  if (realpathSync(toplevel) !== realpathSync(cwd))
    throw new CliError("Run this command from the repository root.");
  const gitDir = gitOutput(cwd, "rev-parse", "--absolute-git-dir");
  const commonDir = gitOutput(cwd, "rev-parse", "--git-common-dir");
  if (realpathSync(gitDir) !== realpathSync(resolve(cwd, commonDir)))
    throw new CliError(
      "Run this command from the main worktree. Linked worktrees reach .plans through it.",
    );
}

export function gitOutput(dir: string, ...args: string[]): string {
  return gitOutputRaw(dir, ...args).trim();
}

export function gitOutputRaw(dir: string, ...args: string[]): string {
  const output = gitBuffer(dir, ...args);
  const text = output.toString("utf8");
  if (!Buffer.from(text).equals(output))
    throw new CliError("Cannot read non-UTF-8 Git output safely. Resolve the rebase manually.");
  return text;
}

export function gitBuffer(dir: string, ...args: string[]): Buffer {
  const result = spawnSync("git", ["-C", dir, ...args]);
  if (result.error !== undefined) throw gitFailure(args, result.error.message);
  if (result.status !== 0) throw gitFailure(args, result.stderr.toString("utf8"));
  return result.stdout;
}

export function gitOutputOrUndefined(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}

export function gitSucceeds(dir: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
