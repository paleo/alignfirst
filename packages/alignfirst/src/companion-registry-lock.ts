import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

import { CliError } from "./cli-error.js";

const STALE_INCOMPLETE_MS = 30_000;

interface LockSnapshot {
  content: string;
  dev: number;
  ino: number;
  mtimeMs: number;
}

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
        const previous = readLock(lock);
        if (previous && staleLock(previous)) recoverLock(lock, previous);
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
  } finally {
    rmSync(candidate, { force: true });
  }
}

function readLock(path: string): LockSnapshot | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const content = readFileSync(fd, "utf8");
    const { dev, ino, mtimeMs } = fstatSync(fd);
    return { content, dev, ino, mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function staleLock(snapshot: LockSnapshot): boolean {
  const pid = Number(snapshot.content.split(":")[0]);
  if (Number.isSafeInteger(pid) && pid > 0) return !processAlive(pid);
  return Date.now() - snapshot.mtimeMs >= STALE_INCOMPLETE_MS;
}

function recoverLock(path: string, previous: LockSnapshot): void {
  if (!sameLock(path, previous)) return;
  const aside = `${path}.${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    if (!sameLock(aside, previous)) {
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

function sameLock(path: string, previous: LockSnapshot): boolean {
  const current = readLock(path);
  return (
    current !== undefined &&
    current.dev === previous.dev &&
    current.ino === previous.ino &&
    current.mtimeMs === previous.mtimeMs &&
    current.content === previous.content
  );
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
