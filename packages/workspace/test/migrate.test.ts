import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readDevServers } from "../src/dev-servers-registry.js";
import { WorkspaceError } from "../src/errors.js";
import {
  convertSlotsRegistry,
  type OldSlotEntry,
  type OldSlotsRegistry,
  refuseOldRegistry,
  runMigrate,
} from "../src/migrate.js";
import { resolvePortsConfig } from "../src/ports.js";
import type { WorktreeContext } from "../src/worktree.js";
import { readWorkspaces, registryDirFor } from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");
const ports = resolvePortsConfig({
  base: 8100,
  perWorkspace: 10,
  maxWorkspaces: 20,
  names: ["web"],
});

let mainWorktree: string;

beforeEach(() => {
  mainWorktree = mkdtempSync(join(tmpdir(), "migrate-"));
});

afterEach(() => {
  rmSync(mainWorktree, { recursive: true, force: true });
});

function oldEntry(worktree: string, overrides: Partial<OldSlotEntry> = {}): OldSlotEntry {
  return { worktree, createdAt: "2026-05-10T00:00:00.000Z", status: "ready", ...overrides };
}

function convert(slots: Record<string, OldSlotEntry>, withPorts = true) {
  const old: OldSlotsRegistry = { slots };
  return convertSlotsRegistry({ old, mainWorktree, ports: withPorts ? ports : undefined });
}

describe("convertSlotsRegistry", () => {
  it("keys linked entries by the worktree basename and copies their fields", () => {
    const failure = { at: "2026-05-11T00:00:00.000Z", message: "boom" };
    const { registry, stale } = convert({
      "8110": oldEntry("/repo/wt-a", { status: "failed", failure, extra: { container: "db-a" } }),
    });
    expect(stale).toEqual([]);
    expect(registry.workspaces["wt-a"]).toEqual({
      worktree: "/repo/wt-a",
      createdAt: "2026-05-10T00:00:00.000Z",
      status: "failed",
      failure,
      purgeData: { container: "db-a" },
      portIndex: 1,
    });
  });

  it("collapses every main entry into one, keyed by the real main worktree", () => {
    const { registry } = convert({
      "8100": oldEntry("/moved/old-path", { main: true }),
      "28400": oldEntry("/moved/old-path", {
        main: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        extra: { volume: "v1" },
      }),
    });
    expect(Object.keys(registry.workspaces)).toEqual([basename(mainWorktree)]);
    const entry = registry.workspaces[basename(mainWorktree)];
    expect(entry.main).toBe(true);
    expect(entry.worktree).toBe(mainWorktree);
    expect(entry.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(entry.purgeData).toEqual({ volume: "v1" });
    expect(entry.portIndex).toBeUndefined();
  });

  it("treats an unflagged entry pointing at the main worktree as main", () => {
    const { registry } = convert({ "8100": oldEntry(mainWorktree) });
    expect(registry.workspaces[basename(mainWorktree)].main).toBe(true);
  });

  it("dedupes same-path linked duplicates, keeping the newest entry and its slot", () => {
    const { registry } = convert({
      "8110": oldEntry("/repo/wt-a"),
      "8130": oldEntry("/repo/wt-a", { createdAt: "2026-06-01T00:00:00.000Z" }),
    });
    expect(Object.keys(registry.workspaces)).toEqual(["wt-a"]);
    expect(registry.workspaces["wt-a"].createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(registry.workspaces["wt-a"].portIndex).toBe(3);
  });

  it("marks entries whose slot does not fit the ports scheme as stale, without an index", () => {
    const { registry, stale } = convert({
      "8115": oldEntry("/repo/wt-odd"),
      "8100": oldEntry("/repo/wt-base"),
      "8400": oldEntry("/repo/wt-far"),
    });
    expect(stale.sort()).toEqual(["wt-base", "wt-far", "wt-odd"]);
    for (const name of stale) {
      expect(registry.workspaces[name].portIndex).toBeUndefined();
    }
  });

  it("allocates no index in portless mode and reports nothing stale", () => {
    const { registry, stale } = convert({ "8110": oldEntry("/repo/wt-a") }, false);
    expect(stale).toEqual([]);
    expect(registry.workspaces["wt-a"].portIndex).toBeUndefined();
  });

  it("throws when two distinct worktrees share a directory name", () => {
    expect(() =>
      convert({
        "8110": oldEntry("/repo/wt-a"),
        "8120": oldEntry("/elsewhere/wt-a"),
      }),
    ).toThrow(WorkspaceError);
  });
});

function mainCtx(): WorktreeContext {
  return { currentWorktree: mainWorktree, mainWorktree, isMainWorktree: true };
}

function writeOldRegistry(slots: Record<string, OldSlotEntry>): string {
  const dir = join(mainWorktree, registryDir);
  mkdirSync(dir, { recursive: true });
  const slotsPath = join(dir, "slots.json");
  writeFileSync(slotsPath, JSON.stringify({ slots }, undefined, 2));
  return slotsPath;
}

function migrate(hasPurgeInfrastructure = false): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    runMigrate(mainCtx(), { registryDir, ports, hasPurgeInfrastructure });
    return log.mock.calls.map((args) => args.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("runMigrate", () => {
  it("converts slots.json to workspaces.json and deletes the old file", () => {
    const slotsPath = writeOldRegistry({
      "8100": oldEntry(mainWorktree, { main: true }),
      "8110": oldEntry("/repo/wt-a"),
    });
    const output = migrate();
    expect(existsSync(slotsPath)).toBe(false);
    const registry = readWorkspaces(mainWorktree, registryDir);
    expect(Object.keys(registry.workspaces).sort()).toEqual(
      [basename(mainWorktree), "wt-a"].sort(),
    );
    expect(output).toContain("Migrated 2 workspace(s)");
    expect(output).toContain("Deleted slots.json.");
  });

  it("rekeys dev-servers.json entries from slot to name", () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    writeFileSync(
      join(mainWorktree, registryDir, "dev-servers.json"),
      JSON.stringify({
        servers: [
          {
            slot: 8110,
            worktree: "/repo/wt-a",
            pids: { web: 1234 },
            startedAt: "2026-05-10T00:00:00.000Z",
          },
        ],
      }),
    );
    migrate();
    const { servers } = readDevServers(mainWorktree, registryDir);
    expect(servers).toEqual([
      {
        name: "wt-a",
        worktree: "/repo/wt-a",
        pids: { web: 1234 },
        startedAt: "2026-05-10T00:00:00.000Z",
      },
    ]);
  });

  it("warns about slot-named infrastructure only when purgeInfrastructure is declared", () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    expect(migrate(true)).toContain("no longer be derived");
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    rmSync(join(mainWorktree, registryDir, "workspaces.json"));
    expect(migrate(false)).not.toContain("no longer be derived");
  });

  it("reports stale entries and orphans", () => {
    writeOldRegistry({ "8115": oldEntry("/gone/wt-odd") });
    const output = migrate();
    expect(output).toContain("No port index could be derived for: wt-odd");
    expect(output).toContain("Orphaned entries kept");
  });

  it("does nothing when there is no slots.json", () => {
    expect(migrate()).toContain("Nothing to migrate");
    expect(existsSync(join(mainWorktree, registryDir, "workspaces.json"))).toBe(false);
  });

  it("refuses when workspaces.json already exists alongside slots.json", () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    migrate();
    const slotsPath = writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    expect(() => migrate()).toThrow(/already migrated/);
    expect(existsSync(slotsPath)).toBe(true);
  });

  it("refuses to run from a linked worktree", () => {
    const ctx: WorktreeContext = {
      currentWorktree: "/repo/wt-a",
      mainWorktree,
      isMainWorktree: false,
    };
    expect(() => runMigrate(ctx, { registryDir, ports, hasPurgeInfrastructure: false })).toThrow(
      /main worktree/,
    );
  });
});

describe("refuseOldRegistry", () => {
  it("exits with a migrate hint when slots.json exists", () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => refuseOldRegistry(mainWorktree, registryDir)).toThrow("EXIT");
      expect(error.mock.calls.join("\n")).toContain("migrate-registry-0.30");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("stays silent when there is no old registry", () => {
    expect(() => refuseOldRegistry(mainWorktree, registryDir)).not.toThrow();
  });
});
