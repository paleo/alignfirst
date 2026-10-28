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
import { dirname, join, resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import { assertRegistryPath, assertSelectedRegistry } from "./registry-ownership.js";
import { claimRegistryStorage } from "./registry-storage.js";

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
  const directory = resolve(mainWorktree, registryDir);
  assertSelectedRegistry(mainWorktree, directory);
  const lockPath = join(directory, LOCK_FILENAME);
  const content = `${process.pid}:${randomBytes(8).toString("hex")}`;
  await acquireLock(mainWorktree, lockPath, content, timings);
  try {
    assertSelectedRegistry(mainWorktree, directory);
    claimRegistryStorage(mainWorktree, directory);
    return await fn();
  } finally {
    assertRegistryPath(mainWorktree, directory, lockPath);
    releaseLock(lockPath, content);
  }
}

async function acquireLock(
  mainWorktree: string,
  lockPath: string,
  content: string,
  timings: LockTimings,
): Promise<void> {
  const retryMs = timings.retryMs ?? RETRY_MS;
  const staleMs = timings.staleMs ?? STALE_MS;
  const deadline = Date.now() + (timings.timeoutMs ?? TIMEOUT_MS);
  assertRegistryPath(mainWorktree, dirname(lockPath), lockPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    assertRegistryPath(mainWorktree, dirname(lockPath), lockPath);
    if (tryCreateLock(lockPath, content)) return;
    const staleContent = findStaleLock(lockPath, staleMs);
    if (staleContent !== undefined) {
      breakStaleLock(lockPath, staleContent);
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

/** Creates the lock file holding `<pid>:<token>`. */
function tryCreateLock(lockPath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (hasErrorCode(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * The lock file's content when its holder is dead or the file is older than `staleMs`. A file
 * without a PID yet (its holder is between the create and the write) is judged by its age only.
 */
function findStaleLock(lockPath: string, staleMs: number): string | undefined {
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
  if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) return content;
  if (Date.now() - stats.mtimeMs > staleMs) return content;
}

/**
 * Moves the stale lock aside, then deletes it. Only one waiter's rename succeeds; the others get
 * `ENOENT` and retry. A waiter whose rename moved a fresh lock instead (another waiter already
 * replaced the stale one) puts it back. The lock's unique token tells them apart.
 */
function breakStaleLock(lockPath: string, staleContent: string): void {
  const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  if (readFileSync(aside, "utf-8") !== staleContent) restoreLock(aside, lockPath);
  rmSync(aside, { force: true });
}

/**
 * Links the moved fresh lock back. `EEXIST` means a third process created a lock in between: two
 * holders then overlap, a window too narrow to close without OS-level locks.
 */
function restoreLock(aside: string, lockPath: string): void {
  try {
    linkSync(aside, lockPath);
  } catch (err) {
    if (!hasErrorCode(err, "EEXIST")) throw err;
  }
}

/** Deletes the lock only while it still holds this holder's token: a broken lock is left alone. */
function releaseLock(lockPath: string, content: string): void {
  let current: string;
  try {
    current = readFileSync(lockPath, "utf-8");
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  if (current === content) rmSync(lockPath, { force: true });
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
