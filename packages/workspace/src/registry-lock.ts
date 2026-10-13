import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";

const LOCK_FILENAME = "workspaces.lock";
const RETRY_MS = 50;
const TIMEOUT_MS = 10_000;
const STALE_MS = 30_000;

/** Overrides for the lock timings, in milliseconds. Meant for tests. */
export interface LockTimings {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Runs `fn` while holding the registry lock, `<registryDir>/workspaces.lock`. The lock covers only a
 * read-modify-write of the registry JSON: never call a callback, git or Docker inside `fn`.
 */
export async function withRegistryLock<T>(
  mainWorktree: string,
  registryDir: string,
  fn: () => T | Promise<T>,
  timings: LockTimings = {},
): Promise<T> {
  const lockPath = join(mainWorktree, registryDir, LOCK_FILENAME);
  await acquireLock(lockPath, timings);
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string, timings: LockTimings): Promise<void> {
  const retryMs = timings.retryMs ?? RETRY_MS;
  const staleMs = timings.staleMs ?? STALE_MS;
  const deadline = Date.now() + (timings.timeoutMs ?? TIMEOUT_MS);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    if (tryCreateLock(lockPath)) return;
    const stale = findStaleLock(lockPath, staleMs);
    if (stale) {
      breakStaleLock(lockPath, stale);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new WorkspaceError(
        `Timed out waiting for the registry lock ${lockPath}. ` +
          "Delete it if no workspace command is running.",
      );
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

function tryCreateLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (hasErrorCode(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * The lock file's stats when its holder is dead or the file is older than `staleMs`. A file without
 * a PID yet (its holder is between the create and the write) is judged by its age only.
 */
function findStaleLock(lockPath: string, staleMs: number): Stats | undefined {
  let stats: Stats;
  let content: string;
  try {
    stats = statSync(lockPath);
    content = readFileSync(lockPath, "utf-8");
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  const pid = Number.parseInt(content, 10);
  if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) return stats;
  if (Date.now() - stats.mtimeMs > staleMs) return stats;
}

/**
 * Moves the stale lock aside, then deletes it. Only one waiter's rename succeeds; the others get
 * `ENOENT` and retry. A waiter whose rename moved a fresh lock instead (another waiter already
 * replaced the stale one) puts it back.
 */
function breakStaleLock(lockPath: string, stale: Stats): void {
  const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  if (statSync(aside).ino !== stale.ino) restoreLock(aside, lockPath);
  rmSync(aside, { force: true });
}

function restoreLock(aside: string, lockPath: string): void {
  try {
    linkSync(aside, lockPath);
  } catch (err) {
    if (!hasErrorCode(err, "EEXIST")) throw err;
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
