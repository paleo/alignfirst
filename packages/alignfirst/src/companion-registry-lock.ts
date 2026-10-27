import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  linkSync,
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
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const previous = lockContent(lock);
      const pid = Number(previous?.split(":")[0]);
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        !processAlive(pid) &&
        lockContent(lock) === previous
      )
        recoverDeadLock(lock, previous);
      if (Date.now() >= deadline)
        throw new CliError(`Timed out waiting for companion registry lock ${lock}.`);
      await setTimeout(25);
    }
  }
  try {
    return mutate();
  } finally {
    if (lockContent(lock) === token) rmSync(lock, { force: true });
  }
}

function recoverDeadLock(path: string, previous: string | undefined): void {
  const aside = `${path}.${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    if (lockContent(aside) !== previous) {
      try {
        linkSync(aside, path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
  } finally {
    rmSync(aside, { force: true });
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
