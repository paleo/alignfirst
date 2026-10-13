import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePortsConfig } from "../src/ports.js";
import {
  indexOfEntry,
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  type RegisterWorkspaceInput,
  rekeyMainEntry,
  resolveCurrentWorkspace,
  type WorkspaceEntry,
  workspacesFilePath,
  writeWorkspaces,
} from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");
const ports = resolvePortsConfig({ base: 8100, maxWorkspaces: 20, names: ["web"] });
const CREATED_AT = "2026-05-10T00:00:00.000Z";

/** Holds the main worktree, `<root>/main`, and its sibling worktrees. */
let root: string;
let mainWorktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspaces-"));
  mainWorktree = join(root, "main");
  mkdirSync(mainWorktree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(worktree: string, status: WorkspaceEntry["status"] = "ready"): WorkspaceEntry {
  return { worktree, createdAt: CREATED_AT, status };
}

function register(worktree: string, overrides: Partial<RegisterWorkspaceInput> = {}) {
  return registerWorkspace({
    currentWorktree: worktree,
    mainWorktree,
    registryDir,
    isMainWorktree: false,
    ...overrides,
  });
}

function registerMain(overrides: Partial<RegisterWorkspaceInput> = {}) {
  return register(mainWorktree, { isMainWorktree: true, ...overrides });
}

/** Writes `workspaces.json` as is, bypassing the conversion of `writeWorkspaces`. */
function writeStored(workspaces: Record<string, unknown>): void {
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(workspacesFilePath(mainWorktree, registryDir), JSON.stringify({ workspaces }));
}

function readStored(): { workspaces: Record<string, WorkspaceEntry> } {
  return JSON.parse(readFileSync(workspacesFilePath(mainWorktree, registryDir), "utf-8"));
}

function readEntries(): Record<string, WorkspaceEntry> {
  return readWorkspaces(mainWorktree, registryDir).workspaces;
}

describe("registryDirFor", () => {
  it("appends the workspace-registry subdir to runtimeDir", () => {
    expect(registryDirFor(".local-wt")).toBe(join(".local-wt", "workspace-registry"));
  });
});

describe("registerWorkspace", () => {
  it("keys the entry by the worktree directory basename", async () => {
    const registered = await register("/repo/myrepo-feat-a");
    expect(registered.name).toBe("myrepo-feat-a");
    expect(registered.status).toBe("pending");
    const workspaces = readEntries();
    expect(Object.keys(workspaces)).toEqual(["myrepo-feat-a"]);
    expect(workspaces["myrepo-feat-a"].worktree).toBe("/repo/myrepo-feat-a");
  });

  it("flags the main worktree and stores no port index", async () => {
    const { name, portIndex } = await registerMain({ ports });
    expect(name).toBe("main");
    expect(portIndex).toBeUndefined();
    expect(readEntries()[name].main).toBe(true);
  });

  it("refuses a name already taken by another worktree", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "myrepo-feat-a": entry("/elsewhere/myrepo-feat-a") },
    });
    await expect(register("/repo/myrepo-feat-a")).rejects.toThrow(
      "already taken by /elsewhere/myrepo-feat-a",
    );
  });

  it("keeps createdAt, purgeData, the dev fields and a ready status across a re-register", async () => {
    const devSetupFailure = { at: CREATED_AT, message: "boom" };
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        "wt-a": {
          ...entry("/repo/wt-a"),
          purgeData: { container: "db-wt-a" },
          ports: { web: 8200 },
          devSetupAt: CREATED_AT,
          devSetupFailure,
        },
      },
    });
    const registered = await register("/repo/wt-a");
    expect(registered.status).toBe("ready");
    const stored = readEntries()["wt-a"];
    expect(stored.createdAt).toBe(CREATED_AT);
    expect(stored.purgeData).toEqual({ container: "db-wt-a" });
    expect(stored.ports).toEqual({ web: 8200 });
    expect(stored.devSetupAt).toBe(CREATED_AT);
    expect(stored.devSetupFailure).toEqual(devSetupFailure);
  });

  it("resets a ready workspace to pending with `force`", async () => {
    writeWorkspaces(mainWorktree, registryDir, { workspaces: { "wt-a": entry("/repo/wt-a") } });
    expect((await register("/repo/wt-a", { force: true })).status).toBe("pending");
  });

  it("allocates the lowest free port index, main worktree excluded", async () => {
    expect((await register("/repo/wt-a", { ports })).portIndex).toBe(1);
    expect((await register("/repo/wt-b", { ports })).portIndex).toBe(2);
    const registry = readWorkspaces(mainWorktree, registryDir);
    delete registry.workspaces["wt-a"];
    writeWorkspaces(mainWorktree, registryDir, registry);
    expect((await register("/repo/wt-c", { ports })).portIndex).toBe(1);
  });

  it("reuses the port index of an already registered worktree", async () => {
    await register("/repo/wt-a", { ports });
    const second = await register("/repo/wt-b", { ports });
    expect((await register("/repo/wt-b", { ports, force: true })).portIndex).toBe(second.portIndex);
  });

  it("allocates no port index in portless mode", async () => {
    expect((await register("/repo/wt-a")).portIndex).toBeUndefined();
    expect(readEntries()["wt-a"].portIndex).toBeUndefined();
  });

  it("fails when every port index is taken", async () => {
    const capped = resolvePortsConfig({ base: 8100, maxWorkspaces: 3, names: ["web"] });
    await register("/repo/wt-a", { ports: capped });
    await register("/repo/wt-b", { ports: capped });
    await expect(register("/repo/wt-c", { ports: capped })).rejects.toThrow(
      "All 3 workspace indexes are taken",
    );
  });

  it("registers a moved main worktree again without a name collision", async () => {
    await registerMain();
    const movedMain = join(root, "elsewhere", "main");
    mkdirSync(join(root, "elsewhere"));
    renameSync(mainWorktree, movedMain);
    mainWorktree = movedMain;
    const registered = await registerMain();
    expect(registered.name).toBe("main");
    expect(readEntries().main.worktree).toBe(movedMain);
  });

  it("registers a main worktree whose legacy entry holds the old absolute path", async () => {
    writeStored({ main: { ...entry("/old/place/main"), main: true } });
    const registered = await registerMain();
    expect(registered.status).toBe("ready");
    expect(readStored().workspaces.main.worktree).toBe(".");
  });
});

describe("stored form", () => {
  it("stores a linked worktree relative to the main worktree, and the main entry as `.`", async () => {
    await registerMain();
    await register(join(root, "wt-a"));
    const { workspaces } = readStored();
    expect(workspaces.main.worktree).toBe(".");
    expect(workspaces["wt-a"].worktree).toBe("../wt-a");
  });

  it("hands absolute paths to readers", async () => {
    await register(join(root, "wt-a"));
    expect(readEntries()["wt-a"].worktree).toBe(join(root, "wt-a"));
  });
});

describe("readWorkspaces repair", () => {
  it("points a legacy main entry at the main worktree", () => {
    writeStored({ main: { ...entry("/old/place/main"), main: true } });
    expect(readEntries().main.worktree).toBe(mainWorktree);
  });

  it("keeps a legacy path that exists", () => {
    const worktree = join(root, "elsewhere", "wt-a");
    mkdirSync(worktree, { recursive: true });
    writeStored({ "wt-a": entry(worktree) });
    expect(readEntries()["wt-a"].worktree).toBe(worktree);
  });

  it("points a missing legacy path at the sibling of the main worktree with the same name", () => {
    mkdirSync(join(root, "wt-a"));
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    expect(readEntries()["wt-a"].worktree).toBe(join(root, "wt-a"));
  });

  it("keeps a missing legacy path without a sibling, as an orphan", () => {
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    expect(readEntries()["wt-a"].worktree).toBe("/old/place/wt-a");
  });

  it("sets devSetupAt to createdAt on a ready legacy entry only", () => {
    writeStored({
      "wt-ready": entry("/old/wt-ready"),
      "wt-pending": entry("/old/wt-pending", "pending"),
      "wt-relative": entry("../wt-relative"),
    });
    const workspaces = readEntries();
    expect(workspaces["wt-ready"].devSetupAt).toBe(CREATED_AT);
    expect(workspaces["wt-pending"].devSetupAt).toBeUndefined();
    expect(workspaces["wt-relative"].devSetupAt).toBeUndefined();
  });

  it("keeps the main entry keyed by the current name among duplicates", () => {
    writeStored({
      "old-name": { ...entry("/old/old-name"), main: true, createdAt: "2026-09-01T00:00:00.000Z" },
      main: { ...entry("/old/main"), main: true },
    });
    expect(Object.keys(readEntries())).toEqual(["main"]);
  });

  it("keeps the newest main entry among duplicates when none has the current name", () => {
    writeStored({
      "name-a": { ...entry("/old/name-a"), main: true },
      "name-b": { ...entry("/old/name-b"), main: true, createdAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(Object.keys(readEntries())).toEqual(["name-b"]);
  });

  it("persists the repair on the next write, in the relative form", () => {
    mkdirSync(join(root, "wt-a"));
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    writeWorkspaces(mainWorktree, registryDir, readWorkspaces(mainWorktree, registryDir));
    expect(readStored().workspaces["wt-a"]).toEqual({
      ...entry("../wt-a"),
      devSetupAt: CREATED_AT,
    });
  });
});

describe("main-entry re-key", () => {
  it("moves the main entry under the new name, keeps its fields and clears devSetupAt", async () => {
    writeStored({
      "old-name": {
        ...entry("."),
        main: true,
        ports: { web: 8200 },
        purgeData: { volume: "v1" },
        devSetupAt: CREATED_AT,
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registered = await registerMain();
      expect(registered).toEqual({ name: "main", status: "ready", portIndex: undefined });
      expect(error.mock.calls.join("\n")).toContain('renamed from "old-name" to "main"');
    } finally {
      error.mockRestore();
    }
    const workspaces = readEntries();
    expect(Object.keys(workspaces)).toEqual(["main"]);
    expect(workspaces.main).toEqual({
      worktree: mainWorktree,
      createdAt: CREATED_AT,
      status: "ready",
      main: true,
      ports: { web: 8200 },
      purgeData: { volume: "v1" },
    });
  });

  it("returns nothing when the main entry already has the current name", () => {
    const registry = { workspaces: { main: { ...entry(mainWorktree), main: true } } };
    expect(rekeyMainEntry(registry, mainWorktree)).toBeUndefined();
    expect(Object.keys(registry.workspaces)).toEqual(["main"]);
  });
});

describe("markWorkspaceReady", () => {
  it("marks the entry ready and persists the purgeData blob", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": entry("/repo/wt-a", "pending") },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "wt-a", { container: "db-wt-a" });
    const stored = readEntries()["wt-a"];
    expect(stored.status).toBe("ready");
    expect(stored.purgeData).toEqual({ container: "db-wt-a" });
  });

  it("leaves a pre-existing purgeData untouched when none is passed", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": { ...entry("/repo/wt-a", "pending"), purgeData: { volume: "v1" } } },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "wt-a");
    expect(readEntries()["wt-a"].purgeData).toEqual({ volume: "v1" });
  });
});

describe("indexOfEntry", () => {
  it("reports index 0 for the main worktree", () => {
    expect(indexOfEntry({ ...entry("/repo/main"), main: true })).toBe(0);
  });

  it("reports the stored index of a linked workspace", () => {
    expect(indexOfEntry({ ...entry("/repo/wt-a"), portIndex: 3 })).toBe(3);
  });

  it("reports undefined for an entry registered without ports", () => {
    expect(indexOfEntry(entry("/repo/wt-a"))).toBeUndefined();
  });
});

describe("resolveCurrentWorkspace", () => {
  it("resolves the entry whose worktree is the cwd", () => {
    const cwd = process.cwd();
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { here: entry(cwd), elsewhere: entry("/repo/wt-b") },
    });
    const resolved = resolveCurrentWorkspace(mainWorktree, registryDir);
    expect(resolved).toEqual({ name: "here", worktree: cwd });
  });
});
