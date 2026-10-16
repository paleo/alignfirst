import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  type RegisterWorkspaceInput,
  rekeyMainEntry,
  resolveCurrentWorkspace,
  storedPortsOf,
  type WorkspaceEntry,
  workspacesFilePath,
  writeWorkspaces,
} from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");
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

/** Writes `workspaces.json` as is. Without `version`, as 0.36 or older wrote it. */
function writeStored(workspaces: Record<string, unknown>, version?: number): void {
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(
    workspacesFilePath(mainWorktree, registryDir),
    JSON.stringify({ version, workspaces }),
  );
}

function readStored(): { version?: number; workspaces: Record<string, WorkspaceEntry> } {
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

  it("flags the main worktree", async () => {
    const { name } = await registerMain();
    expect(name).toBe("main");
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

  it("keeps createdAt, purgeData, ports, devSetupAt and a ready status across a re-register", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        "wt-a": {
          ...entry("/repo/wt-a"),
          purgeData: { container: "db-wt-a" },
          ports: { web: 8200 },
          devSetupAt: CREATED_AT,
          devSetupFailure: { at: CREATED_AT, message: "boom" },
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
    expect(stored.devSetupFailure).toBeUndefined();
  });

  it("finalizes a main entry that `dev setup` created", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { main: { ...entry(mainWorktree), main: true, neverFinalized: true } },
    });
    expect((await registerMain()).status).toBe("pending");
    expect(readEntries().main).not.toHaveProperty("neverFinalized");
  });

  it("resets a ready workspace to pending with `force`", async () => {
    writeWorkspaces(mainWorktree, registryDir, { workspaces: { "wt-a": entry("/repo/wt-a") } });
    expect((await register("/repo/wt-a", { force: true })).status).toBe("pending");
  });

  it("allocates no port", async () => {
    await register("/repo/wt-a");
    expect(readEntries()["wt-a"].ports).toBeUndefined();
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

  it("registers a main worktree whose entry holds its old path", async () => {
    writeStored({ main: { ...entry("/old/place/main"), main: true } }, 2);
    const registered = await registerMain();
    expect(registered.status).toBe("ready");
    expect(readStored().workspaces.main.worktree).toBe(mainWorktree);
  });
});

describe("stored form", () => {
  it("stores absolute paths and the format version", async () => {
    await registerMain();
    await register(join(root, "wt-a"));
    const { version, workspaces } = readStored();
    expect(version).toBe(2);
    expect(workspaces.main.worktree).toBe(mainWorktree);
    expect(workspaces["wt-a"].worktree).toBe(join(root, "wt-a"));
  });

  it("replaces the file through a rename, leaving no temporary file", async () => {
    await registerMain();
    await register(join(root, "wt-a"));
    expect(readdirSync(join(mainWorktree, registryDir))).toEqual(["workspaces.json"]);
  });
});

describe("readWorkspaces repair", () => {
  it("points the main entry at the main worktree", () => {
    writeStored({ main: { ...entry("/old/place/main"), main: true } });
    expect(readEntries().main.worktree).toBe(mainWorktree);
  });

  it("keeps a path that exists, so the main worktree moves alone", () => {
    const worktree = join(root, "elsewhere", "wt-a");
    mkdirSync(worktree, { recursive: true });
    writeStored({ "wt-a": entry(worktree) });
    expect(readEntries()["wt-a"].worktree).toBe(worktree);
  });

  it("points a missing path at the sibling of the main worktree with the same name", () => {
    mkdirSync(join(root, "wt-a"));
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    expect(readEntries()["wt-a"].worktree).toBe(join(root, "wt-a"));
  });

  it("keeps a missing path without a sibling, as an orphan", () => {
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    expect(readEntries()["wt-a"].worktree).toBe("/old/place/wt-a");
  });

  it("sets devSetupAt to createdAt on the ready entries of a registry without version", () => {
    writeStored({
      "wt-ready": entry("/old/wt-ready"),
      "wt-pending": entry("/old/wt-pending", "pending"),
    });
    const workspaces = readEntries();
    expect(workspaces["wt-ready"].devSetupAt).toBe(CREATED_AT);
    expect(workspaces["wt-pending"].devSetupAt).toBeUndefined();
  });

  it("leaves devSetupAt unset on a ready entry of a versioned registry", () => {
    writeStored({ "wt-ready": entry("/old/wt-ready") }, 2);
    expect(readEntries()["wt-ready"].devSetupAt).toBeUndefined();
  });

  it("drops a legacy portIndex", () => {
    writeStored({ "wt-legacy": { ...entry("/old/wt-legacy"), portIndex: 2 } });
    expect(readEntries()["wt-legacy"]).not.toHaveProperty("portIndex");
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

  describe("a relative path", () => {
    const originalCwd = process.cwd();

    afterEach(() => {
      process.chdir(originalCwd);
    });

    it("resolves against the main worktree and persists the absolute path", () => {
      mkdirSync(join(root, "proj-feat"));
      process.chdir(mainWorktree);
      writeStored({ "proj-feat": entry("../proj-feat") });
      writeWorkspaces(mainWorktree, registryDir, readWorkspaces(mainWorktree, registryDir));
      expect(readStored().version).toBe(2);
      expect(readStored().workspaces["proj-feat"].worktree).toBe(join(root, "proj-feat"));
    });

    it("becomes an absolute orphan when it exists only from the cwd", () => {
      const cwd = join(root, "other", "cwd");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(root, "other", "proj-feat"));
      process.chdir(cwd);
      writeStored({ "proj-feat": entry("../proj-feat") });
      expect(readEntries()["proj-feat"].worktree).toBe(join(root, "proj-feat"));
    });
  });

  it("persists the repair on the next write", () => {
    mkdirSync(join(root, "wt-a"));
    writeStored({ "wt-a": entry("/old/place/wt-a") });
    writeWorkspaces(mainWorktree, registryDir, readWorkspaces(mainWorktree, registryDir));
    expect(readStored()).toEqual({
      version: 2,
      workspaces: { "wt-a": { ...entry(join(root, "wt-a")), devSetupAt: CREATED_AT } },
    });
  });
});

describe("main-entry re-key", () => {
  it("moves the main entry and clears infrastructure and run-file setup state", async () => {
    writeStored({
      "old-name": {
        ...entry("."),
        main: true,
        ports: { web: 8200 },
        purgeData: { volume: "v1" },
        devSetupAt: CREATED_AT,
        runFilesWrittenWith: { ports: { web: 8200 }, inputs: {} },
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registered = await registerMain();
      expect(registered).toEqual({ name: "main", status: "ready" });
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
  it("marks the entry ready and clears its failure", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        "wt-a": { ...entry("/repo/wt-a", "failed"), failure: { at: CREATED_AT, message: "boom" } },
      },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "wt-a");
    const stored = readEntries()["wt-a"];
    expect(stored.status).toBe("ready");
    expect(stored.failure).toBeUndefined();
  });

  it("leaves a legacy purgeData untouched", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": { ...entry("/repo/wt-a", "pending"), purgeData: { volume: "v1" } } },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "wt-a");
    expect(readEntries()["wt-a"].purgeData).toEqual({ volume: "v1" });
  });
});

describe("storedPortsOf", () => {
  it("returns the ports of the entry whose worktree matches, or none", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        "wt-a": { ...entry(join(root, "wt-a")), ports: { web: 8100 } },
        "wt-b": entry(join(root, "wt-b")),
      },
    });
    expect(storedPortsOf(mainWorktree, registryDir, join(root, "wt-a"))).toEqual({ web: 8100 });
    expect(storedPortsOf(mainWorktree, registryDir, join(root, "wt-b"))).toEqual({});
    expect(storedPortsOf(mainWorktree, registryDir, join(root, "wt-z"))).toEqual({});
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
