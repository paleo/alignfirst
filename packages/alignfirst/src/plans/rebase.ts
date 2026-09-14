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
  const inProgress = ["rebase-merge", "rebase-apply"].some((name) => {
    const path = gitOutputOrUndefined(repoDir, "rev-parse", "--git-path", name);
    return path !== undefined && path !== "" && existsSync(resolve(repoDir, path));
  });
  if (!inProgress) return;
  const conflicts = gitOutputRaw(repoDir, "diff", "-z", "--name-only", "--diff-filter=U");
  return {
    repoDir,
    conflictedFiles: conflicts.split("\0").filter((path) => path !== ""),
  };
}

export function resolveStoppedRebase(streams: Streams, repoDir: string): void {
  for (let step = 0; findStoppedRebase(repoDir) !== undefined; ++step) {
    if (step >= MAX_REBASE_STEPS)
      throw new CliError(`Could not finish the stopped rebase in ${repoDir}.`);
    resolveConflictedPaths(repoDir, streams.stdout);
    git(streams, repoDir, "add", "-A");
    continueRebase(streams, repoDir);
  }
}

function continueRebase(streams: Streams, repoDir: string): void {
  const args = ["-c", "core.editor=true", "rebase", "--continue"];
  try {
    git(streams, repoDir, ...args);
  } catch (error) {
    const stopped = findStoppedRebase(repoDir);
    if (stopped?.conflictedFiles.length) return;
    if (stopped && gitSucceeds(repoDir, "diff", "--cached", "--quiet")) {
      git(streams, repoDir, "rebase", "--skip");
      return;
    }
    throw error;
  }
}

export function renderStoppedRebase(stopped: StoppedRebase, form: string): string {
  const files = stopped.conflictedFiles.map((path) => `  ${path}`);
  return [
    `Plans synchronization stopped on a conflict in ${stopped.repoDir}:`,
    ...files,
    "Resolve the markers in these files, then run:",
    `  git -C ${stopped.repoDir} add -A && git -C ${stopped.repoDir} rebase --continue`,
    `  ${form} sync`,
    `To discard the local side instead: git -C ${stopped.repoDir} rebase --abort`,
  ].join("\n");
}
