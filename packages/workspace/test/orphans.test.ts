import { describe, expect, it } from "vitest";

import { findOrphanNames } from "../src/orphans.js";
import type { WorkspacesRegistry } from "../src/workspaces.js";

function registry(): WorkspacesRegistry {
  return {
    workspaces: {
      main: {
        worktree: "/repo/main",
        createdAt: "2026-05-10T00:00:00.000Z",
        status: "ready",
        main: true,
      },
      "wt-a": { worktree: "/repo/wt-a", createdAt: "2026-05-10T00:00:00.000Z", status: "ready" },
      "wt-b": { worktree: "/repo/wt-b", createdAt: "2026-05-10T00:00:00.000Z", status: "ready" },
    },
  };
}

describe("findOrphanNames", () => {
  it("returns linked workspaces whose worktree directory is missing", () => {
    const exists = (p: string) => p !== "/repo/wt-b";
    expect(findOrphanNames(registry(), exists)).toEqual(["wt-b"]);
  });

  it("never reports the main worktree even when its directory is missing", () => {
    expect(findOrphanNames(registry(), () => false)).toEqual(["wt-a", "wt-b"]);
  });

  it("returns an empty array when every worktree exists", () => {
    expect(findOrphanNames(registry(), () => true)).toEqual([]);
  });
});
