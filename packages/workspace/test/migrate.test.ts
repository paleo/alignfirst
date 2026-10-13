import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { WorktreeContext } from "../src/worktree.js";
import { readWorkspaces, registryDirFor, workspacesFilePath } from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");

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

function convert(slots: Record<string, OldSlotEntry>) {
  const old: OldSlotsRegistry = { slots };
  return convertSlotsRegistry({ old, mainWorktree });
}

describe("convertSlotsRegistry", () => {
  it("keys linked entries by the worktree basename and copies their fields, without ports", () => {
    const failure = { at: "2026-05-11T00:00:00.000Z", message: "boom" };
    const registry = convert({
      "8110": oldEntry("/repo/wt-a", { status: "failed", failure, extra: { container: "db-a" } }),
    });
    expect(registry.workspaces["wt-a"]).toEqual({
      worktree: "/repo/wt-a",
      createdAt: "2026-05-10T00:00:00.000Z",
      status: "failed",
      failure,
      purgeData: { container: "db-a" },
    });
  });

  it("collapses every main entry into one, keyed by the real main worktree", () => {
    const registry = convert({
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
    expect(entry.ports).toBeUndefined();
  });

  it("treats an unflagged entry pointing at the main worktree as main", () => {
    const registry = convert({ "8100": oldEntry(mainWorktree) });
    expect(registry.workspaces[basename(mainWorktree)].main).toBe(true);
  });

  it("dedupes same-path linked duplicates, keeping the newest entry", () => {
    const registry = convert({
      "8110": oldEntry("/repo/wt-a"),
      "8130": oldEntry("/repo/wt-a", { createdAt: "2026-06-01T00:00:00.000Z" }),
    });
    expect(Object.keys(registry.workspaces)).toEqual(["wt-a"]);
    expect(registry.workspaces["wt-a"].createdAt).toBe("2026-06-01T00:00:00.000Z");
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

async function migrate(hasPurgeInfrastructure = false): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMigrate(mainCtx(), { registryDir, hasPurgeInfrastructure });
    return log.mock.calls.map((args) => args.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("runMigrate", () => {
  it("converts slots.json to workspaces.json and deletes the old file", async () => {
    const slotsPath = writeOldRegistry({
      "8100": oldEntry(mainWorktree, { main: true }),
      "8110": oldEntry("/repo/wt-a"),
    });
    const output = await migrate();
    expect(existsSync(slotsPath)).toBe(false);
    const registry = readWorkspaces(mainWorktree, registryDir);
    expect(Object.keys(registry.workspaces).sort()).toEqual(
      [basename(mainWorktree), "wt-a"].sort(),
    );
    expect(output).toContain("Migrated 2 workspace(s)");
    expect(output).toContain("Deleted slots.json.");
  });

  it("writes the versioned registry, with devSetupAt on ready entries", async () => {
    writeOldRegistry({
      "8100": oldEntry(mainWorktree, { main: true }),
      "8110": oldEntry("/repo/wt-a"),
      "8120": oldEntry("/repo/wt-b", { status: "failed" }),
    });
    await migrate();
    const { version, workspaces } = JSON.parse(
      readFileSync(workspacesFilePath(mainWorktree, registryDir), "utf-8"),
    );
    expect(version).toBe(2);
    const main = workspaces[basename(mainWorktree)];
    expect(main.worktree).toBe(mainWorktree);
    expect(main.devSetupAt).toBe("2026-05-10T00:00:00.000Z");
    expect(workspaces["wt-a"].worktree).toBe("/repo/wt-a");
    expect(workspaces["wt-a"].devSetupAt).toBe("2026-05-10T00:00:00.000Z");
    expect(workspaces["wt-b"].devSetupAt).toBeUndefined();
  });

  it("rekeys dev-servers.json entries from slot to name", async () => {
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
    await migrate();
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

  it("warns about slot-named infrastructure only when purgeInfrastructure is declared", async () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    const output = await migrate(true);
    expect(output).toContain("no longer be derived");
    expect(output).toContain("next dev start");
    expect(output).not.toContain("setup --force");
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    rmSync(join(mainWorktree, registryDir, "workspaces.json"));
    expect(await migrate(false)).not.toContain("no longer be derived");
  });

  it("reports orphans", async () => {
    writeOldRegistry({ "8115": oldEntry("/gone/wt-odd") });
    const output = await migrate();
    expect(output).toContain("Orphaned entries kept");
  });

  it("does nothing when there is no slots.json", async () => {
    expect(await migrate()).toContain("Nothing to migrate");
    expect(existsSync(join(mainWorktree, registryDir, "workspaces.json"))).toBe(false);
  });

  it("refuses when workspaces.json already exists alongside slots.json", async () => {
    writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    await migrate();
    const slotsPath = writeOldRegistry({ "8110": oldEntry("/repo/wt-a") });
    await expect(migrate()).rejects.toThrow(/already migrated/);
    expect(existsSync(slotsPath)).toBe(true);
  });

  it("refuses to run from a linked worktree", async () => {
    const ctx: WorktreeContext = {
      currentWorktree: "/repo/wt-a",
      mainWorktree,
      isMainWorktree: false,
    };
    await expect(runMigrate(ctx, { registryDir, hasPurgeInfrastructure: false })).rejects.toThrow(
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
