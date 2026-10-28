import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

import { CliError } from "./cli-error.js";

/** Companion mutations never hold this lock while acquiring a workspace runtime lock. */
export async function withCompanionRegistryLock<T>(path: string, mutate: () => T): Promise<T> {
  const lock = `${path}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 10_000;
  mkdirSync(dirname(path), { recursive: true });
  const candidate = `${lock}.${randomUUID()}.candidate`;
  const fd = openSync(candidate, "wx");
  try {
    try {
      writeFileSync(fd, token);
    } finally {
      closeSync(fd);
    }
    for (;;) {
      try {
        linkSync(candidate, lock);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        // Recovery requires quiescing all writers and waiters, including paused publishers.
        if (Date.now() >= deadline)
          throw new CliError(
            `Timed out waiting for companion registry lock ${lock}. ` +
              "If abandoned or incomplete, quiesce all companion-registry writers and waiters, " +
              "including paused publishers and older CLI processes, before removing only this lock and retrying. " +
              "A dead recorded PID alone does not establish safe recovery.",
          );
        await setTimeout(25);
      }
    }
    try {
      return mutate();
    } finally {
      if (lockContent(lock) === token) rmSync(lock, { force: true });
    }
  } finally {
    rmSync(candidate, { force: true });
  }
}

function lockContent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
