import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { CliError } from "./cli-error.js";

export function git(dir: string, ...args: string[]): void {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });
  } catch {
    throw gitFailure(args);
  }
}

function gitFailure(args: string[]): CliError {
  return new CliError(`git ${args[0]} failed. See the git output above.`);
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
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
  } catch {
    throw gitFailure(args);
  }
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
