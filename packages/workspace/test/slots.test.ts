import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePortScheme } from "../src/ports.js";
import {
  markSlotReady,
  mergeSlots,
  readSlots,
  registryDirFor,
  resolveAndRegisterSlot,
  type SlotEntry,
  type SlotsRegistry,
  writeSlots,
} from "../src/slots.js";

function slot(worktree: string, status: SlotEntry["status"] = "ready"): SlotEntry {
  return { worktree, createdAt: "2026-05-10T00:00:00.000Z", status };
}

describe("registryDirFor", () => {
  it("appends the workspace-registry subdir to runtimeDir", () => {
    expect(registryDirFor(".local-wt")).toBe(join(".local-wt", "workspace-registry"));
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

describe("extra persistence", () => {
  const scheme = resolvePortScheme({ basePort: 8100 });
  const registryDir = registryDirFor(".local-wt");
  let mainWorktree: string;

  beforeEach(() => {
    mainWorktree = mkdtempSync(join(tmpdir(), "slots-extra-"));
  });

  afterEach(() => {
    rmSync(mainWorktree, { recursive: true, force: true });
  });

  it("markSlotReady persists the extra blob on the slot entry", () => {
    writeSlots(mainWorktree, registryDir, {
      slots: { "8110": slot("/tmp/wt", "pending") },
    });
    markSlotReady(mainWorktree, registryDir, 8110, { container: "db-slot-8110" });
    const entry = readSlots(mainWorktree, registryDir).slots["8110"];
    expect(entry.status).toBe("ready");
    expect(entry.extra).toEqual({ container: "db-slot-8110" });
  });

  it("markSlotReady leaves a pre-existing extra untouched when none is passed", () => {
    writeSlots(mainWorktree, registryDir, {
      slots: { "8110": { ...slot("/tmp/wt", "pending"), extra: { volume: "v1" } } },
    });
    markSlotReady(mainWorktree, registryDir, 8110);
    expect(readSlots(mainWorktree, registryDir).slots["8110"].extra).toEqual({ volume: "v1" });
  });

  it("resolveAndRegisterSlot preserves an existing extra across re-registration", () => {
    writeSlots(mainWorktree, registryDir, {
      slots: { "8110": { ...slot("/tmp/wt", "ready"), extra: { container: "db-slot-8110" } } },
    });
    resolveAndRegisterSlot({
      slot: "8110",
      currentWorktree: "/tmp/wt",
      mainWorktree,
      registryDir,
      scheme,
      isMainWorktree: false,
      force: true,
    });
    expect(readSlots(mainWorktree, registryDir).slots["8110"].extra).toEqual({
      container: "db-slot-8110",
    });
  });
});
