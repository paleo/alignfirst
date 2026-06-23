import { describe, expect, it } from "vitest";

import { findOrphanPorts } from "../src/orphans.js";
import type { SlotsRegistry } from "../src/slots.js";

function registry(): SlotsRegistry {
  return {
    slots: {
      "8100": {
        worktree: "/repo/main",
        createdAt: "2026-05-10T00:00:00.000Z",
        status: "ready",
        main: true,
      },
      "8110": { worktree: "/repo/wt-a", createdAt: "2026-05-10T00:00:00.000Z", status: "ready" },
      "8120": { worktree: "/repo/wt-b", createdAt: "2026-05-10T00:00:00.000Z", status: "ready" },
    },
  };
}

describe("findOrphanPorts", () => {
  it("returns linked slots whose worktree directory is missing", () => {
    const exists = (p: string) => p !== "/repo/wt-b";
    expect(findOrphanPorts(registry(), exists)).toEqual(["8120"]);
  });

  it("never reports the main worktree even when its directory is missing", () => {
    const exists = () => false;
    expect(findOrphanPorts(registry(), exists)).toEqual(["8110", "8120"]);
  });

  it("returns an empty array when every worktree exists", () => {
    expect(findOrphanPorts(registry(), () => true)).toEqual([]);
  });
});
