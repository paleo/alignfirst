import { describe, expect, it } from "vitest";

import { buildWorktreeReadyMessage } from "../src/dev-setup.js";
import type { WorkspaceCommands } from "../src/invocation.js";
import type { WorkspaceEntry } from "../src/workspaces.js";

const NOW = Date.parse("2026-05-17T00:00:00.000Z");

const PM: WorkspaceCommands = {
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

function input(entry: WorkspaceEntry): Parameters<typeof buildWorktreeReadyMessage>[0] {
  return {
    name: "repo-feat-a",
    worktreePath: "/tmp/wt",
    runtimeDir: ".local-wt",
    entry,
    now: NOW,
    pm: PM,
  };
}

describe("buildWorktreeReadyMessage", () => {
  it("returns ok when status is ready", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "ready",
      recipe: { kind: "defaults" },
    };
    expect(buildWorktreeReadyMessage(input(entry))).toEqual({ ok: true });
  });

  it("refuses a pending workspace without finalize admission", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "pending",
      recipe: { kind: "defaults" },
    };
    expect(buildWorktreeReadyMessage(input(entry)).ok).toBe(false);
  });

  it("accepts a pending workspace with `acceptPending` (the finalize child of `setup --full`)", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "pending",
      recipe: { kind: "defaults" },
    };
    expect(buildWorktreeReadyMessage({ ...input(entry), acceptPending: true })).toEqual({
      ok: true,
    });
  });

  it("still refuses a failed workspace with `acceptPending`", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T22:00:00.000Z",
      status: "failed",
      recipe: { kind: "defaults" },
    };
    expect(buildWorktreeReadyMessage({ ...input(entry), acceptPending: true }).ok).toBe(false);
  });

  it("refuses a failed workspace", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T22:00:00.000Z",
      status: "failed",
      recipe: { kind: "defaults" },
      failure: { at: "2026-05-16T23:30:00.000Z", message: "boom" },
    };
    expect(buildWorktreeReadyMessage(input(entry)).ok).toBe(false);
  });
});
