import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { gitOutput } from "../git.js";

export interface SyncLock {
  kind: "acquired";
  release(): void;
}

export interface SyncLockBusy {
  kind: "busy";
  path: string;
  pid: number | undefined;
}

export function acquireSyncLock(repoDir: string): SyncLock | SyncLockBusy {
  const path = resolve(
    repoDir,
    gitOutput(repoDir, "rev-parse", "--git-path", "alignfirst-sync.lock"),
  );
  if (createLock(path)) return lockHandle(path);
  const pid = readPid(path);
  if (pid !== undefined && processGone(pid)) {
    rmSync(path, { recursive: true, force: true });
    if (createLock(path)) return lockHandle(path);
    return { kind: "busy", path, pid: readPid(path) };
  }
  return { kind: "busy", path, pid };
}

function createLock(path: string): boolean {
  try {
    mkdirSync(path);
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    writeFileSync(join(path, "pid"), String(process.pid));
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function lockHandle(path: string): SyncLock {
  return { kind: "acquired", release: () => rmSync(path, { recursive: true, force: true }) };
}

function readPid(path: string): number | undefined {
  try {
    const value = readFileSync(join(path, "pid"), "utf8").trim();
    const pid = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(pid) && pid > 0) return pid;
  } catch {
    return;
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
