import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { CliError } from "../cli-error.js";
import type { Output } from "../context.js";
import { git, gitOutput, gitOutputOrUndefined, gitSucceeds } from "../git.js";

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
  const conflicts = gitOutputOrUndefined(repoDir, "diff", "--name-only", "--diff-filter=U");
  return {
    repoDir,
    conflictedFiles: conflicts?.split("\n").filter((path) => path !== "") ?? [],
  };
}

export function resolveStoppedRebase(repoDir: string, stdout: Output): void {
  for (let step = 0; findStoppedRebase(repoDir) !== undefined; ++step) {
    if (step >= MAX_REBASE_STEPS)
      throw new CliError(`Could not finish the stopped rebase in ${repoDir}.`);
    resolveConflictedPaths(repoDir, stdout);
    git(repoDir, "add", "-A");
    continueRebase(repoDir);
  }
}

function resolveConflictedPaths(repoDir: string, stdout: Output): void {
  const paths = gitOutput(repoDir, "diff", "--name-only", "--diff-filter=U")
    .split("\n")
    .filter((path) => path !== "");
  for (const path of paths) resolveConflictedPath(repoDir, path, stdout);
}

function resolveConflictedPath(repoDir: string, path: string, stdout: Output): void {
  const stages = conflictedPathStages(repoDir, path);
  if (stages.has(2) && stages.has(3)) {
    git(repoDir, "checkout", "--theirs", "--", path);
    stdout.write(`Resolved ${path}: kept the local version.\n`);
    return;
  }
  stdout.write(`Resolved ${path}: kept the paths present in the working tree.\n`);
}

function conflictedPathStages(repoDir: string, path: string): Set<number> {
  const entries = gitOutputOrUndefined(repoDir, "ls-files", "-u", "--", path);
  if (entries === undefined || entries === "") return new Set();
  return new Set(
    entries.split("\n").flatMap((entry) => {
      const match = /^\d+ [0-9a-f]+ ([123])\t/.exec(entry);
      return match === null ? [] : [Number(match[1])];
    }),
  );
}

function continueRebase(repoDir: string): void {
  const args = ["-c", "core.editor=true", "rebase", "--continue"];
  try {
    git(repoDir, ...args);
  } catch (error) {
    const stopped = findStoppedRebase(repoDir);
    if (stopped?.conflictedFiles.length) return;
    if (stopped && gitSucceeds(repoDir, "diff", "--cached", "--quiet")) {
      git(repoDir, "rebase", "--skip");
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
