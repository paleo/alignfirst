import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registryLockPath, withRegistryLock } from "../src/registry-lock.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("withRegistryLock", () => {
  it("times out on a live owner through deterministic timing seams", async () => {
    const path = makeRegistryPath();
    writeOwner(path, 123);
    let now = 0;

    await expect(
      withRegistryLock(path, () => undefined, {
        isProcessAlive: () => true,
        now: () => now,
        retryIntervalMs: 5,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/Registry is busy/);
    expect(existsSync(registryLockPath(path))).toBe(true);
  });

  it("reclaims a dead owner and releases after the action", async () => {
    const path = makeRegistryPath();
    writeOwner(path, 123);

    await expect(
      withRegistryLock(path, () => "done", { isProcessAlive: () => false }),
    ).resolves.toBe("done");
    expect(existsSync(registryLockPath(path))).toBe(false);
  });

  it("reclaims an owner whose PID was reused by another process", async () => {
    const path = makeRegistryPath();
    writeOwner(path, 123, "original-process");

    await expect(
      withRegistryLock(path, () => "done", {
        isProcessAlive: () => true,
        processStartMarker: () => "reused-pid-process",
      }),
    ).resolves.toBe("done");
    expect(existsSync(registryLockPath(path))).toBe(false);
  });

  it("reclaims incomplete metadata only after its grace interval", async () => {
    const path = makeRegistryPath();
    const lockPath = registryLockPath(path);
    mkdirSync(lockPath);
    const incompletePath = join(lockPath, "claim-incomplete");
    writeFileSync(incompletePath, "");
    utimesSync(incompletePath, new Date(0), new Date(0));

    await withRegistryLock(path, () => undefined, { incompleteGraceMs: 10, now: () => 100 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the claim after an action exception", async () => {
    const path = makeRegistryPath();
    await expect(
      withRegistryLock(path, () => {
        throw new Error("failure inside lock");
      }),
    ).rejects.toThrow(/failure inside lock/);
    expect(existsSync(registryLockPath(path))).toBe(false);
  });

  it("serializes concurrent contenders", async () => {
    const path = makeRegistryPath();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRegistryLock(path, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = withRegistryLock(path, () => {
      events.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("serializes concurrent contenders while reclaiming a dead owner", async () => {
    const path = makeRegistryPath();
    writeOwner(path, 999_999);
    const events: string[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withRegistryLock(path, async () => {
          events.push(`start-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`end-${index}`);
        }),
      ),
    );

    let active = 0;
    for (const event of events) {
      active += event.startsWith("start-") ? 1 : -1;
      expect(active).toBeLessThanOrEqual(1);
    }
    expect(active).toBe(0);
    expect(existsSync(registryLockPath(path))).toBe(false);
  });

  it("observes contention from a real child process", async () => {
    const path = makeRegistryPath();
    const child = fork(new URL("fixtures/hold-registry-lock.mjs", import.meta.url), [path], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await waitForMessage(child, "locked");
    await expect(withRegistryLock(path, () => undefined, { timeoutMs: 30 })).rejects.toThrow(
      /Registry is busy/,
    );
    child.send("release");
    await waitForExit(child);
    await expect(withRegistryLock(path, () => "acquired")).resolves.toBe("acquired");
  });
});

function makeRegistryPath(): string {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-lock-"));
  return join(fixtureDir, "registry.json");
}

function writeOwner(registryFile: string, pid: number, startMarker?: string): void {
  const lockPath = registryLockPath(registryFile);
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, `claim-${pid}-owner.json`),
    `${JSON.stringify({ pid, ticket: 1, token: "owner", startMarker })}\n`,
  );
}

function waitForMessage(child: ReturnType<typeof fork>, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Lock child exited early with code ${code}`)));
    child.on("message", (message) => {
      if (message === expected) resolve();
    });
  });
}

function waitForExit(child: ReturnType<typeof fork>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock child exited with code ${code}`));
    });
  });
}
