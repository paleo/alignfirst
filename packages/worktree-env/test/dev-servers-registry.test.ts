import { describe, expect, it } from "vitest";

import { pruneDeadServers, type DevServerEntry } from "../src/dev-servers-registry.js";

function entry(slot: number, pids: Record<string, number>): DevServerEntry {
  return {
    slot,
    worktree: `/tmp/wt-${slot}`,
    branch: `feat/${slot}`,
    owner: "alice",
    pids,
    startedAt: "2026-05-10T00:00:00.000Z",
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
