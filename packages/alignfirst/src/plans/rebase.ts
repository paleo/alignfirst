import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { CliError } from "../cli-error.js";
import type { Streams } from "../context.js";
import { git, gitOutputRaw, gitOutputOrUndefined, gitSucceeds } from "../git.js";
import { resolveConflictedPaths } from "./conflicts.js";

const MAX_REBASE_STEPS = 100;

export interface StoppedRebase {
  repoDir: string;
  conflictedFiles: string[];
}

export function findStoppedRebase(repoDir: string): StoppedRebase | undefined {
  if (!rebaseInProgress(repoDir)) return;
  const conflicts = gitOutputRaw(repoDir, "diff", "-z", "--name-only", "--diff-filter=U");
  return {
    repoDir,
    conflictedFiles: conflicts.split("\0").filter((path) => path !== ""),
  };
}

// Decodes no path, so it also answers when a conflicted name cannot be read losslessly.
export function rebaseInProgress(repoDir: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((name) => {
    const path = gitOutputOrUndefined(repoDir, "rev-parse", "--git-path", name);
    return path !== undefined && path !== "" && existsSync(resolve(repoDir, path));
  });
}

export async function resolveStoppedRebase(streams: Streams, repoDir: string): Promise<void> {
  for (let step = 0; findStoppedRebase(repoDir) !== undefined; ++step) {
    if (step >= MAX_REBASE_STEPS)
      throw new CliError(`Could not finish the stopped rebase in ${repoDir}.`);
    const changed = resolveConflictedPaths(streams, repoDir);
    if (changed.length > 0)
      await git(streams, repoDir, "add", "-A", "--", ...changed.map((path) => `:(literal)${path}`));
    await continueRebase(streams, repoDir);
  }
}

async function continueRebase(streams: Streams, repoDir: string): Promise<void> {
  const args = ["rebase", "--continue"];
  try {
    await git(streams, repoDir, ...args);
  } catch (error) {
    const stopped = findStoppedRebase(repoDir);
    if (stopped?.conflictedFiles.length) return;
    if (
      stopped &&
      gitSucceeds(repoDir, "diff", "--cached", "--quiet") &&
      gitSucceeds(repoDir, "diff", "--quiet")
    ) {
      await git(streams, repoDir, "rebase", "--skip");
      return;
    }
    throw error;
  }
}

export function renderStoppedRebase(stopped: StoppedRebase, form: string): string {
  const files = stopped.conflictedFiles.map((path) => `  ${path}`);
  return [
    `Work-files synchronization stopped on a conflict in ${stopped.repoDir}:`,
    ...files,
    "Resolve the markers in these files, then run:",
    `  git -C ${stopped.repoDir} add -A && git -C ${stopped.repoDir} rebase --continue`,
    `  ${form} sync`,
    `To abandon the rebase and return the branch to its state before the pull, keeping the local commits: git -C ${stopped.repoDir} rebase --abort`,
  ].join("\n");
}
