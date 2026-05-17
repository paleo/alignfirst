import { describe, expect, it } from "vitest";

import { buildWorktreeReadyMessage } from "../src/dev-server.js";
import type { SlotEntry } from "../src/slots.js";

const NOW = Date.parse("2026-05-17T00:00:00.000Z");

function input(entry: SlotEntry | undefined): Parameters<typeof buildWorktreeReadyMessage>[0] {
  return {
    slotPort: 8110,
    worktreePath: "/tmp/wt",
    runtimeDir: ".local-wt",
    entry,
    now: NOW,
  };
}

describe("buildWorktreeReadyMessage", () => {
  it("returns ok when entry is absent (synthesized main)", () => {
    expect(buildWorktreeReadyMessage(input(undefined))).toEqual({ ok: true });
  });

  it("returns ok when status is ready", () => {
    const entry: SlotEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "ready",
    };
    expect(buildWorktreeReadyMessage(input(entry))).toEqual({ ok: true });
  });

  it("reports a pending message with slot and elapsed time", () => {
    const entry: SlotEntry = {
      worktree: "/tmp/wt",
      createdAt: "2026-05-16T23:00:00.000Z",
      status: "pending",
    };
    const result = buildWorktreeReadyMessage(input(entry));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("still in progress");
    expect(result.message).toContain("slot 8110");
    expect(result.message).toContain("1h");
    expect(result.message).toContain("/tmp/wt/.local-wt/wt-setup.log");
  });

  it("reports a failed message with failure reason and elapsed", () => {
    const entry: SlotEntry = {
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
    expect(result.message).toContain("setup-worktree --here");
  });

  it("uses (no message) when failure.message is absent", () => {
    const entry: SlotEntry = {
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
