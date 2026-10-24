import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError } from "../cli-error.js";
import { gitOutputRaw } from "../git.js";
import { assertRegularPath } from "./conflicts.js";

export interface PendingWrite {
  path: string;
  content: Buffer | undefined;
}

export function capturePendingWrites(repoDir: string): PendingWrite[] {
  const status = gitOutputRaw(repoDir, "status", "--porcelain", "-z", "--untracked-files=no");
  return status
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (entry[0] !== " ")
        throw new CliError(
          "Resolve the rebase manually: the work-files index changed during synchronization.",
        );
      const path = entry.slice(3);
      assertRegularPath(repoDir, path);
      return { path, content: entry[1] === "D" ? undefined : readFileSync(join(repoDir, path)) };
    });
}

export function restorePendingWrites(repoDir: string, writes: PendingWrite[]): void {
  for (const { path, content } of writes) {
    assertRegularPath(repoDir, path);
    const target = join(repoDir, path);
    if (content === undefined) {
      rmSync(target, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}
