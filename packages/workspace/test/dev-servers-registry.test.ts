import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoPendingCleanup,
  completeDevServerCleanup,
  devServersFilePath,
  findOwnEntry,
  liveDevServers,
  markDevServerCleanupPending,
  pruneAndPersist,
  registerDevServer,
  stopAllRegistered,
  evictOldest,
  liveWorktrees,
  pruneDeadServers,
  readDevServers,
  writeDevServers,
  type DevServerEntry,
} from "../src/dev-servers-registry.js";

import { claimStartup, releaseStartup } from "../src/startup-ownership.js";

function entry(
  name: string,
  pids: Record<string, number>,
  startedAt = "2026-05-10T00:00:00.000Z",
): DevServerEntry {
  return {
    name,
    worktree: `/tmp/wt-${name}`,
    pids,
    startedAt,
  };
}

describe("pruneDeadServers", () => {
  const isAlive = (pid: number) => pid % 2 === 0; // even = alive, odd = dead

  it("prunes entries where every PID is dead", () => {
    const data = {
      servers: [entry("a", { main: 1, helper: 3 }), entry("b", { main: 4 })],
    };
    const out = pruneDeadServers(data, isAlive);
    expect(out.servers).toHaveLength(1);
    expect(out.servers[0].name).toBe("b");
  });

  it("keeps entries with any live PID", () => {
    const data = { servers: [entry("a", { main: 1, helper: 2 })] };
    expect(pruneDeadServers(data, isAlive).servers).toHaveLength(1);
  });

  it("retains dead cleanup targets without counting them as live", () => {
    const dead = { ...entry("dead", { app: 1 }), cleanupPending: true } as const;
    const live = { ...entry("live", { app: 2 }), cleanupPending: true } as const;
    const data = { servers: [dead, live] };
    expect(pruneDeadServers(data, isAlive).servers).toEqual([dead, live]);
    expect(liveDevServers(data, isAlive)).toEqual([live]);
    expect(liveWorktrees(data, isAlive)).toEqual(new Set([live.worktree]));
  });

  it("preserves order", () => {
    const data = {
      servers: [entry("b", { main: 2 }), entry("a", { main: 4 }), entry("c", { main: 1 })],
    };
    const out = pruneDeadServers(data, isAlive).servers.map((e) => e.name);
    expect(out).toEqual(["b", "a"]);
  });
});

describe("liveWorktrees", () => {
  const isAlive = (pid: number) => pid % 2 === 0; // even = alive, odd = dead

  it("returns only resolved worktrees with a live PID", () => {
    const data = {
      servers: [
        entry("a", { main: 1, helper: 3 }), // all dead
        entry("b", { main: 2 }), // live
        entry("c", { main: 1, helper: 4 }), // one live
      ],
    };
    expect(liveWorktrees(data, isAlive)).toEqual(new Set(["/tmp/wt-b", "/tmp/wt-c"]));
  });

  it("returns an empty set when every entry is dead", () => {
    const data = { servers: [entry("a", { main: 1 })] };
    expect(liveWorktrees(data, isAlive).size).toBe(0);
  });
});

describe("evictOldest", () => {
  let mainWorktree: string;
  const registryDir = ".local/_workspace-registry";
  const isAlive = () => true;
  const stopTarget = async () => {};

  beforeEach(() => {
    mainWorktree = mkdtempSync(join(tmpdir(), "wt-env-test-"));
  });

  afterEach(() => {
    rmSync(mainWorktree, { recursive: true, force: true });
  });

  it.each([undefined, 0, 2])(
    "rejects unsupported dev version %s without overwriting bytes",
    async (version) => {
      mkdirSync(join(mainWorktree, registryDir), { recursive: true });
      const path = devServersFilePath(mainWorktree, registryDir);
      const before = JSON.stringify({ version, servers: [entry("old", { app: 1 })] });
      writeFileSync(path, before);
      expect(() => readDevServers(mainWorktree, registryDir)).toThrow("unsupported registry");
      await expect(
        registerDevServer(mainWorktree, registryDir, entry("new", { app: process.pid })),
      ).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );

  it("marks fresh unpruned dead state and creates pre-registration rollback identities", async () => {
    const old = entry("dead", { app: 99999999 });
    writeDevServers(mainWorktree, registryDir, { servers: [old] });
    await markDevServerCleanupPending(mainWorktree, registryDir, old.worktree);
    const rollback = entry("rollback", {});
    await markDevServerCleanupPending(mainWorktree, registryDir, rollback.worktree, rollback);
    await pruneAndPersist(mainWorktree, registryDir, () => false);
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([
      { ...old, cleanupPending: true },
      { ...rollback, cleanupPending: true },
    ]);
    expect(findOwnEntry(mainWorktree, registryDir, old.worktree)?.name).toBe(old.name);
    expect(() => assertNoPendingCleanup(mainWorktree, registryDir, old.worktree)).toThrow(
      "Cleanup is pending",
    );
    await expect(registerDevServer(mainWorktree, registryDir, old)).rejects.toThrow(
      "Cleanup is pending",
    );
    await completeDevServerCleanup(mainWorktree, registryDir, old.worktree);
    expect(findOwnEntry(mainWorktree, registryDir, rollback.worktree)?.cleanupPending).toBe(true);
    expect(
      JSON.parse(readFileSync(devServersFilePath(mainWorktree, registryDir), "utf8")).version,
    ).toBe(1);
    expect(readdirSync(join(mainWorktree, registryDir))).toEqual(["dev-servers.json"]);
  });

  it("keeps a slow live startup exclusive without retaining the registry lock", async () => {
    const worktree = join(mainWorktree, "target");
    const owner = await claimStartup(mainWorktree, registryDir, worktree);
    const path = join(mainWorktree, registryDir, "dev-startups.json");
    utimesSync(path, new Date(0), new Date(0));
    await expect(claimStartup(mainWorktree, registryDir, worktree)).rejects.toThrow(
      "startup already in progress",
    );
    const sibling = entry("sibling", { app: process.pid });
    await registerDevServer(mainWorktree, registryDir, sibling);
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([sibling]);
    await releaseStartup(mainWorktree, registryDir, owner);
    const replacement = await claimStartup(mainWorktree, registryDir, worktree);
    expect(replacement.id).not.toBe(owner.id);
    await releaseStartup(mainWorktree, registryDir, replacement);
  });

  it("reclaims a dead owner but rejects its stale publication, rollback and release", async () => {
    const worktree = join(mainWorktree, "target");
    const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
    expect(exited.status).toBe(0);
    const deadOwner = { worktree, id: "abandoned", pid: Number(exited.stdout.trim()) };
    mkdirSync(join(mainWorktree, registryDir), { recursive: true });
    writeFileSync(
      join(mainWorktree, registryDir, "dev-startups.json"),
      JSON.stringify({ version: 1, owners: [deadOwner] }),
    );
    const owner = await claimStartup(mainWorktree, registryDir, worktree);
    const winner = {
      ...entry("target", { app: process.pid }),
      worktree,
      instanceId: owner.id,
    };
    await registerDevServer(mainWorktree, registryDir, winner, owner);
    await releaseStartup(mainWorktree, registryDir, deadOwner);
    await expect(claimStartup(mainWorktree, registryDir, worktree)).rejects.toThrow(
      "startup already in progress",
    );
    const stale = { ...winner, instanceId: deadOwner.id };
    await expect(registerDevServer(mainWorktree, registryDir, stale, deadOwner)).rejects.toThrow(
      "ownership lost",
    );
    await expect(
      markDevServerCleanupPending(mainWorktree, registryDir, worktree, stale, deadOwner),
    ).rejects.toThrow("ownership lost");
    expect(
      await markDevServerCleanupPending(mainWorktree, registryDir, worktree, stale),
    ).toBeUndefined();
    await completeDevServerCleanup(
      mainWorktree,
      registryDir,
      worktree,
      winner.startedAt,
      deadOwner.id,
    );
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([winner]);
    await releaseStartup(mainWorktree, registryDir, owner);
  });

  it("preserves child/sibling mutations during cross-target eviction", async () => {
    const victim = entry("victim", { app: 2 });
    const sibling = entry("sibling", { app: process.pid });
    writeDevServers(mainWorktree, registryDir, { servers: [victim] });
    await evictOldest({
      mainWorktree,
      registryDir,
      count: 1,
      isAlive,
      stopTarget: async () => {
        await completeDevServerCleanup(mainWorktree, registryDir, victim.worktree);
        await registerDevServer(mainWorktree, registryDir, sibling);
      },
    });
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([sibling]);
  });

  it("down-all removes only captured paths and retains a child-created sibling", async () => {
    const victim = entry("victim", {});
    victim.cleanupPending = true;
    writeDevServers(mainWorktree, registryDir, { servers: [victim] });
    const sibling = entry("sibling", { app: process.pid });
    await stopAllRegistered({
      mainWorktree,
      registryDir,
      stopTarget: async () => {
        await registerDevServer(mainWorktree, registryDir, sibling);
      },
    });
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([sibling]);
  });

  it("selects the entry with the smallest startedAt", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry("b", { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry("a", { main: 4 }, "2026-05-10T00:00:00.000Z"),
        entry("c", { main: 6 }, "2026-05-10T01:00:00.000Z"),
      ],
    });
    const evicted = await evictOldest({
      mainWorktree,
      registryDir,
      count: 1,
      stopTarget,
      isAlive,
    });
    expect(evicted).toHaveLength(1);
    expect(evicted[0].name).toBe("a");
  });

  it("removes the two oldest when count is 2", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry("b", { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry("a", { main: 4 }, "2026-05-10T00:00:00.000Z"),
        entry("c", { main: 6 }, "2026-05-10T01:00:00.000Z"),
      ],
    });
    const evicted = await evictOldest({
      mainWorktree,
      registryDir,
      count: 2,
      stopTarget,
      isAlive,
    });
    expect(evicted.map((e) => e.name)).toEqual(["a", "c"]);
    const remaining = readDevServers(mainWorktree, registryDir).servers.map((e) => e.name);
    expect(remaining).toEqual(["b"]);
  });

  it("aggregates stop-all failures, retains failed targets and still stops siblings", async () => {
    const victims = [entry("failed", {}), entry("sibling", {})].map((entry) => ({
      ...entry,
      cleanupPending: true as const,
    }));
    writeDevServers(mainWorktree, registryDir, { servers: victims });
    const seen: string[] = [];
    await expect(
      stopAllRegistered({
        mainWorktree,
        registryDir,
        stopTarget: async (target) => {
          seen.push(target.name);
          if (target.name === "failed") throw new Error("stop failed");
        },
      }),
    ).rejects.toThrow("stop failed");
    expect(seen).toEqual(["failed", "sibling"]);
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([victims[0]]);
  });
});
