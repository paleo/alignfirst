import { describe, expect, it } from "vitest";

import { buildWorktreeReadyMessage } from "../src/dev-setup.js";
import type { WorkspaceCommands } from "../src/invocation.js";
import type { WorkspaceEntry } from "../src/workspaces.js";

const PM: WorkspaceCommands = {
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

describe("buildWorktreeReadyMessage", () => {
  it.each<[WorkspaceEntry["status"], boolean, boolean]>([
    ["ready", false, true],
    ["pending", false, false],
    ["pending", true, true],
    ["failed", false, false],
    ["failed", true, false],
  ])("admits a %s workspace (acceptPending=%s): %s", (status, acceptPending, ok) => {
    const entry: WorkspaceEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status,
      recipe: { kind: "defaults" },
      ...(status === "failed"
        ? { failure: { at: "2026-05-16T23:30:00.000Z", message: "boom" } }
        : {}),
    };
    const result = buildWorktreeReadyMessage({
      name: "repo-feat-a",
      worktreePath: "/tmp/wt",
      runtimeDir: ".local-wt",
      entry,
      now: Date.parse("2026-05-17T00:00:00.000Z"),
      pm: PM,
      acceptPending,
    });
    expect(result.ok).toBe(ok);
  });
});
