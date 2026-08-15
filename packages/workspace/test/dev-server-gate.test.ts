import { describe, expect, it } from "vitest";

import { buildWorktreeReadyMessage } from "../src/dev-server.js";
import type { PackageManagerCommands } from "../src/package-manager.js";
import type { WorkspaceEntry } from "../src/workspaces.js";

const NOW = Date.parse("2026-05-17T00:00:00.000Z");

const PM: PackageManagerCommands = {
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

function input(entry: WorkspaceEntry | undefined): Parameters<typeof buildWorktreeReadyMessage>[0] {
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
  it("returns ok when entry is absent (synthesized main)", () => {
    expect(buildWorktreeReadyMessage(input(undefined))).toEqual({ ok: true });
  });

  it("returns ok when status is ready", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "ready",
    };
    expect(buildWorktreeReadyMessage(input(entry))).toEqual({ ok: true });
  });

  it("reports a pending message with the workspace name and elapsed time", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "pending",
    };
    const result = buildWorktreeReadyMessage(input(entry));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("still in progress");
    expect(result.message).toContain("workspace repo-feat-a");
    expect(result.message).toContain("1h");
    expect(result.message).toContain("/tmp/wt/.local-wt/logs/workspace-setup.log");
  });

  it("reports a failed message with failure reason and elapsed", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T22:00:00.000Z",
      status: "failed",
      failure: { at: "2026-05-16T23:30:00.000Z", message: "boom" },
    };
    const result = buildWorktreeReadyMessage(input(entry));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("failed");
    expect(result.message).toContain("boom");
    expect(result.message).toContain("30m");
    expect(result.message).toContain("npm run workspace -- setup");
  });

  it("uses (no message) when failure.message is absent", () => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T22:00:00.000Z",
      status: "failed",
    };
    const result = buildWorktreeReadyMessage(input(entry));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("(no message)");
  });
});
