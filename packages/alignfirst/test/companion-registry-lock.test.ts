import { spawn, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

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

it.each([
  ["", 0],
  ["", 60_000],
  ["not-a-pid:", 60_000],
])("preserves and refuses an incomplete lock %j aged %i ms", async (content, age) => {
  writeLock(content, now - age);
  const original = statSync(lock);
  const mutate = vi.fn();
  await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
    "Timed out waiting for companion registry lock",
  );
  expect(mutate).not.toHaveBeenCalled();
  expect(readFileSync(lock, "utf8")).toBe(content);
  expect(statSync(lock).ino).toBe(original.ino);
  expect(statSync(lock).mtimeMs).toBe(original.mtimeMs);
  expect(readdirSync(root)).toEqual(["registry.json.lock"]);
});

it("acquires after an owner releases normally while a contender waits", async () => {
  let contender: Promise<string> | undefined;
  let ownerActive = false;
  await withCompanionRegistryLock(path, () => {
    ownerActive = true;
    contender = withCompanionRegistryLock(path, () => {
      expect(ownerActive).toBe(false);
      return "acquired after release";
    });
    ownerActive = false;
  });
  expect(contender).toBeDefined();
  await expect(contender).resolves.toBe("acquired after release");
  expect(readdirSync(root)).toEqual([]);
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

it("preserves a dead owner's lock until explicit quiescent recovery permits retry", async () => {
  writeFileSync(path, "preserved registry");
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.status).toBe(0);
  expect(child.pid).toBeDefined();
  const content = `${child.pid}:dead-token`;
  writeLock(content, now);
  const original = statSync(lock);
  const mutate = vi.fn();
  await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
    "Timed out waiting for companion registry lock",
  );
  expect(mutate).not.toHaveBeenCalled();
  expect(readFileSync(lock, "utf8")).toBe(content);
  expect(statSync(lock).ino).toBe(original.ino);
  expect(statSync(lock).mtimeMs).toBe(original.mtimeMs);
  expect(readdirSync(root)).toEqual(["registry.json", "registry.json.lock"]);
  // This isolated fixture's holder exited, the waiter settled, and no publisher remains.
  rmSync(lock);
  await expect(withCompanionRegistryLock(path, () => readFileSync(path, "utf8"))).resolves.toBe(
    "preserved registry",
  );
  expect(readFileSync(path, "utf8")).toBe("preserved registry");
  expect(readdirSync(root)).toEqual(["registry.json"]);
});

it("does not displace owner B or admit contender C after a stale observation", async () => {
  writeLock("", now - 60_000);
  const children: LockWriter[] = [];
  let scheduled = false;
  let ownerInode: number | undefined;
  const scheduleWriters = (pendingRename?: () => void) => {
    scheduled = true;
    // An older recovering waiter removes the abandoned lock while A is paused.
    actualRenameSync(lock, `${lock}.abandoned`);
    children.push(startLockWriter("B"));
    waitForFile(join(root, "B.entered"));
    ownerInode = statSync(lock).ino;
    pendingRename?.();
    children.push(startLockWriter("C"));
    waitForFile(join(root, "C.waiting"), join(root, "C.entered"));
  };
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    // Pause A after its last stale check, but execute its real rename of B's lock.
    scheduleWriters(() => actualRenameSync(from, to));
  });
  vi.mocked(setTimeout).mockImplementation(async (delay = 1) => {
    // Without automatic recovery, schedule the same writers at A's first wait.
    if (!scheduled) scheduleWriters();
    now += delay;
  });

  try {
    const mutate = vi.fn();
    await expect(withCompanionRegistryLock(path, mutate)).rejects.toThrow(
      "Timed out waiting for companion registry lock",
    );
    expect(scheduled).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
    expect(existsSync(join(root, "B.release"))).toBe(false);
    expect(existsSync(join(root, "C.entered"))).toBe(false);
    expect(statSync(lock).ino).toBe(ownerInode);
    writeFileSync(join(root, "B.release"), "");
    waitForFile(join(root, "C.entered"));
  } finally {
    for (const label of ["B", "C"]) writeFileSync(join(root, `${label}.release`), "");
    const results = await Promise.all(children.map((child) => child.done));
    expect(results).toEqual(children.map(() => ({ code: 0, signal: null, stderr: "" })));
  }
  expect(existsSync(lock)).toBe(false);
}, 20_000);

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

interface LockWriter {
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function startLockWriter(label: string): LockWriter {
  const source = fileURLToPath(new URL("../src/companion-registry-lock.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import fs from "node:fs";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const [source, path, root, label] = process.argv.slice(1);
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "./cli-error.js") specifier = "./cli-error.ts";
        return nextResolve(specifier, context);
      },
    });
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      try { return link(...args); }
      catch (error) {
        if (error.code === "EEXIST") fs.writeFileSync(root + "/" + label + ".waiting", "");
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { withCompanionRegistryLock } = await import(pathToFileURL(source).href);
    await withCompanionRegistryLock(path, () => {
      fs.writeFileSync(root + "/" + label + ".entered", "");
      while (!fs.existsSync(root + "/" + label + ".release")) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    });
  `,
      source,
      path,
      root,
      label,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const watchdog = globalThis.setTimeout(() => child.kill("SIGKILL"), 15_000);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve) => {
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code, signal) => {
        globalThis.clearTimeout(watchdog);
        resolve({ code, signal, stderr });
      });
    },
  );
  return { done };
}

function waitForFile(...paths: string[]): void {
  const deadline = performance.now() + 5_000;
  while (!paths.some((file) => existsSync(file))) {
    if (performance.now() >= deadline)
      throw new Error(`Timed out waiting for ${paths.join(" or ")}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function writeLock(content: string, modified: number): void {
  writeFileSync(lock, content);
  const timestamp = new Date(modified);
  utimesSync(lock, timestamp, timestamp);
}
