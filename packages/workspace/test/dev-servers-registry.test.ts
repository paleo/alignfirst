import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evictOldest,
  liveWorktrees,
  pruneDeadServers,
  readDevServers,
  writeDevServers,
  type DevServerEntry,
} from "../src/dev-servers-registry.js";
import type { CallbackServer, ServerContext } from "../src/server-descriptor.js";

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

  it("preserves order", () => {
    const data = {
      servers: [entry("b", { main: 2 }), entry("a", { main: 4 }), entry("c", { main: 1 })],
    };
    const out = pruneDeadServers(data, isAlive).servers.map((e) => e.name);
    expect(out).toEqual(["b", "a"]);
  });

  it("round-trips through JSON", () => {
    const data = { servers: [entry("a", { main: 2 })] };
    const round = JSON.parse(JSON.stringify(data));
    expect(pruneDeadServers(round, isAlive)).toEqual(data);
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
  const stop = async () => {};
  const callbackServers: never[] = [];
  const portsOf = () => ({});

  beforeEach(() => {
    mainWorktree = mkdtempSync(join(tmpdir(), "wt-env-test-"));
  });

  afterEach(() => {
    rmSync(mainWorktree, { recursive: true, force: true });
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
      callbackServers,
      portsOf,
      isAlive,
      stop,
    });
    expect(evicted).toHaveLength(1);
    expect(evicted[0].name).toBe("a");
  });

  it("removes the victim from the registry", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry("b", { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry("a", { main: 4 }, "2026-05-10T00:00:00.000Z"),
      ],
    });
    await evictOldest({
      mainWorktree,
      registryDir,
      count: 1,
      callbackServers,
      portsOf,
      isAlive,
      stop,
    });
    const remaining = readDevServers(mainWorktree, registryDir).servers.map((e) => e.name);
    expect(remaining).toEqual(["b"]);
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
      callbackServers,
      portsOf,
      isAlive,
      stop,
    });
    expect(evicted.map((e) => e.name)).toEqual(["a", "c"]);
    const remaining = readDevServers(mainWorktree, registryDir).servers.map((e) => e.name);
    expect(remaining).toEqual(["b"]);
  });

  it("reverse-stops callbacks with each victim's registered name, root and ports", async () => {
    const victims = [
      { ...entry("review-a1b2c3d4", { main: 4 }), worktree: "/external/one/review" },
      { ...entry("review-e5f6a7b8", { main: 6 }), worktree: "/external/two/review" },
    ];
    writeDevServers(mainWorktree, registryDir, { servers: victims });
    const seen: { label: string; ctx: ServerContext }[] = [];
    const callbacks: CallbackServer[] = ["docker", "cache"].map((label) => ({
      kind: "callback",
      name: label,
      start: async () => {},
      stop: async (ctx) => {
        seen.push({ label, ctx });
      },
    }));
    await evictOldest({
      mainWorktree,
      registryDir,
      count: 2,
      callbackServers: callbacks,
      portsOf: (worktree) => ({ db: worktree === victims[0].worktree ? 8101 : 8102 }),
      isAlive,
      stop,
    });
    expect(seen).toEqual(
      victims.flatMap((victim, i) =>
        ["cache", "docker"].map((label) => ({
          label,
          ctx: { name: victim.name, cwd: victim.worktree, ports: { db: 8101 + i } },
        })),
      ),
    );
    expect(readDevServers(mainWorktree, registryDir).servers).toEqual([]);
  });
});
