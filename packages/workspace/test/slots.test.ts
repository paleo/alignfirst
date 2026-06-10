import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mergeSlots, registryDirFor, type SlotEntry, type SlotsRegistry } from "../src/slots.js";

function slot(worktree: string, status: SlotEntry["status"] = "ready"): SlotEntry {
  return { worktree, createdAt: "2026-05-10T00:00:00.000Z", status };
}

describe("registryDirFor", () => {
  it("appends the shared-registry subdir to runtimeDir", () => {
    expect(registryDirFor(".local-wt")).toBe(join(".local-wt", "shared-registry"));
  });
});

describe("mergeSlots", () => {
  it("lets the override win on a conflicting slot port", () => {
    const base: SlotsRegistry = { slots: { "8110": slot("/tmp/old") } };
    const override: SlotsRegistry = { slots: { "8110": slot("/tmp/new") } };
    expect(mergeSlots(base, override).slots["8110"].worktree).toBe("/tmp/new");
  });

  it("preserves base-only keys", () => {
    const base: SlotsRegistry = { slots: { "8110": slot("/tmp/a"), "8120": slot("/tmp/b") } };
    const override: SlotsRegistry = { slots: { "8120": slot("/tmp/b2") } };
    const merged = mergeSlots(base, override);
    expect(merged.slots["8110"].worktree).toBe("/tmp/a");
    expect(merged.slots["8120"].worktree).toBe("/tmp/b2");
  });
});
