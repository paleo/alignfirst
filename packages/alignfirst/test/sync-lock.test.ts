import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { acquireSyncLock } from "../src/plans/sync-lock.js";
import { configureGit, git, makeTempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("shares its lock through a symlink and releases it", () => {
  const dir = fixture();
  const alias = `${dir}-alias`;
  dirs.push(alias);
  symlinkSync(dir, alias);
  const lock = acquireSyncLock(dir);
  expect(lock.kind).toBe("acquired");
  expect(acquireSyncLock(alias)).toMatchObject({ kind: "busy", pid: process.pid });
  if (lock.kind !== "acquired") throw new Error("Expected lock");
  lock.release();
  const next = acquireSyncLock(alias);
  expect(next.kind).toBe("acquired");
  if (next.kind === "acquired") next.release();
});

it.each(["missing", "invalid", "0", "-1"])("leaves an unreadable pid busy: %s", (value) => {
  const dir = fixture();
  const path = join(dir, ".git/alignfirst-sync.lock");
  mkdirSync(path);
  if (value !== "missing") writeFileSync(join(path, "pid"), value);
  expect(acquireSyncLock(dir)).toEqual({ kind: "busy", path, pid: undefined });
});

it("replaces a lock whose process is conclusively gone", () => {
  const dir = fixture();
  const path = join(dir, ".git/alignfirst-sync.lock");
  mkdirSync(path);
  writeFileSync(join(path, "pid"), "2147483647");
  const lock = acquireSyncLock(dir);
  expect(lock.kind).toBe("acquired");
  expect(readFileSync(join(path, "pid"), "utf8")).toBe(String(process.pid));
  if (lock.kind === "acquired") lock.release();
});

function fixture(): string {
  const dir = makeTempDir("alignfirst-lock-");
  dirs.push(dir);
  configureGit(dir);
  git(dir, "init", "--quiet");
  return dir;
}
