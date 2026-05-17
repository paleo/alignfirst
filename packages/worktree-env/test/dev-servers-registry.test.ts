import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evictOldest,
  pruneDeadServers,
  readDevServers,
  writeDevServers,
  type DevServerEntry,
} from "../src/dev-servers-registry.js";
import type { CallbackServer } from "../src/server-descriptor.js";

function entry(
  slot: number,
  pids: Record<string, number>,
  startedAt = "2026-05-10T00:00:00.000Z",
): DevServerEntry {
  return {
    slot,
    worktree: `/tmp/wt-${slot}`,
    owner: "alice",
    pids,
    startedAt,
  };
}

describe("pruneDeadServers", () => {
  const isAlive = (pid: number) => pid % 2 === 0; // even = alive, odd = dead

  it("prunes entries where every PID is dead", () => {
    const data = {
      servers: [entry(8110, { main: 1, helper: 3 }), entry(8120, { main: 4 })],
    };
    const out = pruneDeadServers(data, isAlive);
    expect(out.servers).toHaveLength(1);
    expect(out.servers[0].slot).toBe(8120);
  });

  it("keeps entries with any live PID", () => {
    const data = { servers: [entry(8110, { main: 1, helper: 2 })] };
    expect(pruneDeadServers(data, isAlive).servers).toHaveLength(1);
  });

  it("preserves order", () => {
    const data = {
      servers: [entry(8120, { main: 2 }), entry(8110, { main: 4 }), entry(8130, { main: 1 })],
    };
    const out = pruneDeadServers(data, isAlive).servers.map((e) => e.slot);
    expect(out).toEqual([8120, 8110]);
  });

  it("round-trips through JSON", () => {
    const data = { servers: [entry(8110, { main: 2 })] };
    const round = JSON.parse(JSON.stringify(data));
    expect(pruneDeadServers(round, isAlive)).toEqual(data);
  });
});

describe("evictOldest", () => {
  let mainWorktree: string;
  const registryDir = ".local/wt-registry";
  const isAlive = () => true;
  const stop = async () => {};
  const callbackServers: never[] = [];

  beforeEach(() => {
    mainWorktree = mkdtempSync(join(tmpdir(), "wt-env-test-"));
  });

  afterEach(() => {
    rmSync(mainWorktree, { recursive: true, force: true });
  });

  it("selects the entry with the smallest startedAt", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry(8120, { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry(8110, { main: 4 }, "2026-05-10T00:00:00.000Z"),
        entry(8130, { main: 6 }, "2026-05-10T01:00:00.000Z"),
      ],
    });
    const evicted = await evictOldest({
      mainWorktree,
      registryDir,
      count: 1,
      callbackServers,
      isAlive,
      stop,
    });
    expect(evicted).toHaveLength(1);
    expect(evicted[0].slot).toBe(8110);
  });

  it("removes the victim from the registry", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry(8120, { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry(8110, { main: 4 }, "2026-05-10T00:00:00.000Z"),
      ],
    });
    await evictOldest({ mainWorktree, registryDir, count: 1, callbackServers, isAlive, stop });
    const remaining = readDevServers(mainWorktree, registryDir).servers.map((e) => e.slot);
    expect(remaining).toEqual([8120]);
  });

  it("removes the two oldest when count is 2", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [
        entry(8120, { main: 2 }, "2026-05-10T02:00:00.000Z"),
        entry(8110, { main: 4 }, "2026-05-10T00:00:00.000Z"),
        entry(8130, { main: 6 }, "2026-05-10T01:00:00.000Z"),
      ],
    });
    const evicted = await evictOldest({
      mainWorktree,
      registryDir,
      count: 2,
      callbackServers,
      isAlive,
      stop,
    });
    expect(evicted.map((e) => e.slot)).toEqual([8110, 8130]);
    const remaining = readDevServers(mainWorktree, registryDir).servers.map((e) => e.slot);
    expect(remaining).toEqual([8120]);
  });

  it("invokes callback stop() with the victim's worktree", async () => {
    writeDevServers(mainWorktree, registryDir, {
      servers: [entry(8110, { main: 4 }, "2026-05-10T00:00:00.000Z")],
    });
    const seen: string[] = [];
    const docker: CallbackServer = {
      kind: "callback",
      name: "docker",
      start: async () => {},
      stop: async (ctx) => {
        seen.push(ctx.cwd);
      },
    };
    await evictOldest({
      mainWorktree,
      registryDir,
      count: 1,
      callbackServers: [docker],
      isAlive,
      stop,
    });
    expect(seen).toEqual(["/tmp/wt-8110"]);
  });
});
