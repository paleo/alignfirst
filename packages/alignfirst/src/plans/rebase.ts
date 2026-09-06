import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { gitOutputOrUndefined } from "../git.js";

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
