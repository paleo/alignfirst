import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDevServers, registerDevServer } from "../src/dev-servers-registry.js";
import { WorkspaceError } from "../src/errors.js";
import { withRegistryLock } from "../src/registry-lock.js";
import { readWorkspaces, registryDirFor, updateWorkspaces } from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");
/** Fails fast instead of waiting 10 seconds when a test leaves the lock held. */
const FAST = { retryMs: 10, timeoutMs: 500 };

let mainWorktree: string;
let lockPath: string;

beforeEach(() => {
  mainWorktree = mkdtempSync(join(tmpdir(), "registry-lock-"));
  lockPath = join(mainWorktree, registryDir, "workspaces.lock");
});

afterEach(() => {
  rmSync(mainWorktree, { recursive: true, force: true });
});

function writeLock(content: string): void {
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(lockPath, content);
}

function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) throw new Error("Could not spawn a short-lived process");
  return pid;
}

describe("withRegistryLock", () => {
  it("holds the lock with its PID and a token while running, and releases it", async () => {
    const result = await withRegistryLock(mainWorktree, registryDir, () =>
      readFileSync(lockPath, "utf-8"),
    );
    expect(result).toMatch(new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
    expect(existsSync(lockPath)).toBe(false);
  });

  it("leaves in place a lock that another holder took over", async () => {
    await withRegistryLock(mainWorktree, registryDir, () => {
      writeFileSync(lockPath, `${process.pid}:other`);
    });
    expect(readFileSync(lockPath, "utf-8")).toBe(`${process.pid}:other`);
  });

  it("releases the lock when the function throws", async () => {
    await expect(
      withRegistryLock(mainWorktree, registryDir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("replaces a stale lock whose holder is dead", async () => {
    writeLock(String(deadPid()));
    await expect(withRegistryLock(mainWorktree, registryDir, () => "ran", FAST)).resolves.toBe(
      "ran",
    );
  });

  it("replaces a stale lock older than 30 seconds", async () => {
    writeLock(String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    await expect(withRegistryLock(mainWorktree, registryDir, () => "ran", FAST)).resolves.toBe(
      "ran",
    );
  });

  it("times out on a live lock with an error naming the lock file", async () => {
    writeLock(String(process.pid));
    const attempt = withRegistryLock(mainWorktree, registryDir, () => "ran", {
      retryMs: 10,
      timeoutMs: 100,
    });
    await expect(attempt).rejects.toThrow(WorkspaceError);
    await expect(attempt).rejects.toThrow(lockPath);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("updateWorkspaces", () => {
  it("serializes dev mutations on the shared lock without losing concurrent registrations", async () => {
    const names = Array.from({ length: 8 }, (_, index) => `dev-${index}`);
    await Promise.all(
      names.map((name) =>
        registerDevServer(mainWorktree, registryDir, {
          name,
          worktree: join(mainWorktree, name),
          pids: { app: process.pid },
          startedAt: "2026-05-10T00:00:00.000Z",
        }),
      ),
    );
    expect(
      readDevServers(mainWorktree, registryDir)
        .servers.map((entry) => entry.name)
        .sort(),
    ).toEqual(names);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("loses no update across concurrent calls", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `wt-${i}`);
    await Promise.all(
      names.map((name) =>
        updateWorkspaces(mainWorktree, registryDir, async (registry) => {
          await new Promise((r) => setTimeout(r, 5));
          registry.workspaces[name] = {
            worktree: join(mainWorktree, "..", name),
            createdAt: "2026-05-10T00:00:00.000Z",
            status: "ready",
            recipe: { kind: "defaults" },
          };
        }),
      ),
    );
    expect(Object.keys(readWorkspaces(mainWorktree, registryDir).workspaces).sort()).toEqual(names);
    expect(existsSync(lockPath)).toBe(false);
  });
});
