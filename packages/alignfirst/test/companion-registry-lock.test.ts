import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import {
  existsSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { withCompanionRegistryLock } from "../src/companion-registry-lock.js";

const actualFs = await vi.importActual<typeof Fs>("node:fs");
const actualRenameSync = actualFs.renameSync;
let root: string;
let path: string;
let lock: string;
let now: number;

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    linkSync: vi.fn(fs.linkSync),
    openSync: vi.fn(fs.openSync),
    renameSync: vi.fn(fs.renameSync),
    writeFileSync: vi.fn(fs.writeFileSync),
  };
});

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "companion-lock-"));
  path = join(root, "registry.json");
  lock = `${path}.lock`;
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(setTimeout).mockImplementation(async (delay = 1) => {
    now += delay;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(linkSync).mockReset().mockImplementation(actualFs.linkSync);
  vi.mocked(openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(renameSync).mockReset().mockImplementation(actualRenameSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
  vi.mocked(setTimeout).mockReset();
  rmSync(root, { recursive: true, force: true });
});

it.each(["", "not-a-pid:"])("recovers an abandoned incomplete lock: %j", async (content) => {
  writeLock(content, now - 60_000);
  await expect(withCompanionRegistryLock(path, () => "mutated")).resolves.toBe("mutated");
  expect(existsSync(lock)).toBe(false);
});

it("does not recover a fresh incomplete lock", async () => {
  writeLock("", now);
  const mutate = vi.fn();
  await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
    "Timed out waiting for companion registry lock",
  );
  expect(mutate).not.toHaveBeenCalled();
  expect(readFileSync(lock, "utf8")).toBe("");
});

it("keeps ownership when a publisher pauses before writing its token", async () => {
  writeFileSync(path, "0");
  let contender: Promise<void> | undefined;
  let publisherInode: number | undefined;
  let publisherOwnedLock = false;
  vi.mocked(openSync).mockImplementationOnce((file, flags, mode) => {
    const fd = actualFs.openSync(file, flags, mode);
    publisherInode = fstatSync(fd).ino;
    const old = new Date(now - 60_000);
    utimesSync(file, old, old);
    contender = withCompanionRegistryLock(path, () => {
      expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid}:.+`));
      writeFileSync(path, String(Number(readFileSync(path, "utf8")) + 1));
    });
    return fd;
  });

  await withCompanionRegistryLock(path, () => {
    publisherOwnedLock = existsSync(lock) && statSync(lock).ino === publisherInode;
    writeFileSync(path, String(Number(readFileSync(path, "utf8")) + 1));
  });
  await contender;

  expect(publisherOwnedLock).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("2");
  expect(readdirSync(root)).toEqual(["registry.json"]);
});

it.each([`${process.pid}:live-token`, String(process.pid)])(
  "never expires a live PID by age: %s",
  async (content) => {
    writeLock(content, now - 60_000);
    const mutate = vi.fn();
    await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
      "Timed out waiting for companion registry lock",
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(readFileSync(lock, "utf8")).toBe(content);
    expect(readdirSync(root)).toEqual(["registry.json.lock"]);
  },
);

it("recovers a dead owner without waiting for its lock to age", async () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.status).toBe(0);
  expect(child.pid).toBeDefined();
  writeLock(`${child.pid}:dead-token`, now);
  await expect(withCompanionRegistryLock(path, () => "mutated")).resolves.toBe("mutated");
  expect(existsSync(lock)).toBe(false);
});

it.each(["", `${process.pid}:replacement`])(
  "restores a lock refreshed during stale recovery: %j",
  async (replacement) => {
    writeLock("", now - 60_000);
    let replacementInode: number | undefined;
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      if (replacement !== "") actualRenameSync(from, `${lock}.original`);
      writeLock(replacement, now);
      replacementInode = statSync(lock).ino;
      actualRenameSync(from, to);
    });
    const mutate = vi.fn();
    await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
      "Timed out waiting for companion registry lock",
    );
    expect(renameSync).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(statSync(lock).ino).toBe(replacementInode);
    expect(readFileSync(lock, "utf8")).toBe(replacement);
  },
);

it("preserves a replacement inode even when its content and timestamp match", async () => {
  const modified = now - 60_000;
  writeLock("", modified);
  let replacementInode: number | undefined;
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    actualRenameSync(from, `${lock}.original`);
    writeLock("", modified);
    replacementInode = statSync(lock).ino;
    actualRenameSync(from, to);
    now += 10_000;
  });
  const mutate = vi.fn();
  await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
    "Timed out waiting for companion registry lock",
  );
  expect(mutate).not.toHaveBeenCalled();
  expect(statSync(lock).ino).toBe(replacementInode);
  expect(readFileSync(lock, "utf8")).toBe("");
});

it.each(["write", "publish"])("cleans its private candidate after a %s error", async (stage) => {
  const failure = Object.assign(new Error("publication failed"), { code: "EIO" });
  if (stage === "write") {
    vi.mocked(writeFileSync).mockImplementationOnce((file) => {
      actualFs.writeFileSync(file, "partial-token");
      throw failure;
    });
  } else {
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw failure;
    });
  }
  const mutate = vi.fn();
  await expect(withCompanionRegistryLock(path, mutate)).rejects.toBe(failure);
  expect(mutate).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual([]);
});

it("releases only its own token, including when the mutation throws", async () => {
  await expect(
    withCompanionRegistryLock(path, () => {
      expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid}:.+`));
      throw new Error("mutation failed");
    }),
  ).rejects.toThrow("mutation failed");
  expect(readdirSync(root)).toEqual([]);

  const replacement = `${process.pid}:replacement`;
  await withCompanionRegistryLock(path, () => writeFileSync(lock, replacement));
  expect(readFileSync(lock, "utf8")).toBe(replacement);
  expect(readdirSync(root)).toEqual(["registry.json.lock"]);
});

function writeLock(content: string, modified: number): void {
  writeFileSync(lock, content);
  const timestamp = new Date(modified);
  utimesSync(lock, timestamp, timestamp);
}
