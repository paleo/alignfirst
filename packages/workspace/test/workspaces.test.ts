import { createHash } from "node:crypto";
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
  allocateWorkspaceName,
  findWorkspaceByPath,
  markWorkspaceFailed,
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  type RegisterWorkspaceInput,
  resolveCurrentWorkspace,
  storedPortsOf,
  updateWorkspaces,
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

  it("allocates distinct names for two external paths sharing a basename", async () => {
    const first = await register("/elsewhere/myrepo-feat-a");
    const second = await register("/repo/myrepo-feat-a");
    expect(first.name).toBe("myrepo-feat-a");
    expect(second.name).toBe(`myrepo-feat-a-${digestOf("/repo/myrepo-feat-a").slice(0, 8)}`);
    expect(readEntries()[first.name].worktree).toBe("/elsewhere/myrepo-feat-a");
    expect(readEntries()[second.name].worktree).toBe("/repo/myrepo-feat-a");
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
  it("leaves no temporary file beside the written registry", async () => {
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

  it("keeps a missing external path beside an unrelated same-named sibling", () => {
    mkdirSync(join(root, "wt-a"));
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
      workspaces: { "wt-a": { ...entry("/old/place/wt-a"), devSetupAt: CREATED_AT } },
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

  it("keeps an unchanged main identity during a locked write", async () => {
    writeStored({ main: { ...entry(mainWorktree), main: true } }, 2);
    await updateWorkspaces(mainWorktree, registryDir, () => {});
    expect(Object.keys(readEntries())).toEqual(["main"]);
  });
});

describe("markWorkspaceReady", () => {
  it("marks the entry ready and clears its failure", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        "wt-a": { ...entry("/repo/wt-a", "failed"), failure: { at: CREATED_AT, message: "boom" } },
      },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "/repo/wt-a");
    const stored = readEntries()["wt-a"];
    expect(stored.status).toBe("ready");
    expect(stored.failure).toBeUndefined();
  });

  it("leaves a legacy purgeData untouched", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": { ...entry("/repo/wt-a", "pending"), purgeData: { volume: "v1" } } },
    });
    await markWorkspaceReady(mainWorktree, registryDir, "/repo/wt-a");
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

function digestOf(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

describe("collision-safe identity", () => {
  it("reuses normalized paths and preserves a suffix and state after its competitor disappears", async () => {
    await register("/first/wt");
    const { name } = await register("/second/wt");
    const basis = { ports: { web: 8200 }, inputs: { host: "localhost" } };
    await updateWorkspaces(mainWorktree, registryDir, (registry) => {
      delete registry.workspaces.wt;
      Object.assign(registry.workspaces[name], {
        createdAt: CREATED_AT,
        status: "ready",
        ports: basis.ports,
        runFilesWrittenWith: basis,
        devSetupAt: CREATED_AT,
        purgeData: { volume: "legacy" },
        devSetupFailure: { at: CREATED_AT, message: "old" },
      });
    });
    expect(await register("/second/other/../wt")).toEqual({ name, status: "ready" });
    expect(readEntries()[name]).toEqual({
      worktree: "/second/wt",
      createdAt: CREATED_AT,
      status: "ready",
      ports: basis.ports,
      runFilesWrittenWith: basis,
      devSetupAt: CREATED_AT,
      purgeData: { volume: "legacy" },
    });
    await markWorkspaceFailed(mainWorktree, registryDir, "/second/wt", "retry");
    expect(await register("/second/wt")).toEqual({ name, status: "pending" });
    expect(readEntries()[name].failure).toBeUndefined();
  });

  it("allocates atomically across concurrent registrations", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `/external/${index}/wt`);
    const results = await Promise.all(paths.map((path) => register(path)));
    expect(new Set(results.map((result) => result.name)).size).toBe(paths.length);
    expect(
      Object.values(readEntries())
        .map((entry) => entry.worktree)
        .sort(),
    ).toEqual(paths.sort());
  });

  it("extends occupied hash candidates and falls back beyond the full digest", () => {
    const path = "/second/wt";
    const digest = digestOf(path);
    const workspaces: Record<string, WorkspaceEntry> = { wt: entry("/first/wt") };
    workspaces[`wt-${digest.slice(0, 8)}`] = entry("/occupied/8");
    expect(allocateWorkspaceName(workspaces, path)).toBe(`wt-${digest.slice(0, 9)}`);
    for (let length = 9; length <= digest.length; ++length) {
      workspaces[`wt-${digest.slice(0, length)}`] = entry(`/occupied/${length}`);
    }
    workspaces[`wt-${digest}-2`] = entry("/occupied/numeric");
    expect(allocateWorkspaceName(workspaces, path)).toBe(`wt-${digest}-3`);
  });

  it("inserts beyond a full occupied digest without overwriting reservations", async () => {
    const path = "/second/wt";
    const digest = digestOf(path);
    const reservations: Record<string, WorkspaceEntry> = { wt: entry("/first/wt") };
    for (let length = 8; length <= digest.length; ++length) {
      reservations[`wt-${digest.slice(0, length)}`] = entry(`/occupied/${length}`);
    }
    reservations[`wt-${digest}-2`] = entry("/occupied/numeric");
    writeWorkspaces(mainWorktree, registryDir, { workspaces: reservations });
    const registered = await register(path);
    expect(registered.name).toBe(`wt-${digest}-3`);
    const entries = readEntries();
    for (const [name, reserved] of Object.entries(reservations)) {
      expect(entries[name]).toEqual(reserved);
    }
    expect((await register("/second/../second/wt")).name).toBe(registered.name);
  });

  it("keeps version 2 and adds no stored identity fields", async () => {
    await register("/first/wt");
    const { name } = await register("/second/wt");
    expect(readStored().version).toBe(2);
    expect(Object.keys(readStored().workspaces[name]).sort()).toEqual([
      "createdAt",
      "status",
      "worktree",
    ]);
  });

  it("never repairs a missing path from a suffixed registry key", () => {
    mkdirSync(join(root, "wt-deadbeef"));
    writeStored({ "wt-deadbeef": entry("/missing/external/wt") }, 2);
    expect(readEntries()["wt-deadbeef"].worktree).toBe("/missing/external/wt");
  });
});

describe("main identity reconciliation", () => {
  it("allocates main and linked collisions in registration order", async () => {
    const linked = await register("/external/main");
    const main = await registerMain();
    expect(linked.name).toBe("main");
    expect(main.name).toBe(`main-${digestOf(mainWorktree).slice(0, 8)}`);
    expect(readEntries()[main.name].main).toBe(true);
    expect(findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), mainWorktree)?.name).toBe(
      main.name,
    );
    writeWorkspaces(mainWorktree, registryDir, { workspaces: {} });
    expect((await registerMain()).name).toBe("main");
    expect((await register("/external/main")).name).toMatch(/^main-[a-f0-9]{8}$/);
  });

  it("keeps an unchanged suffixed main after removing its competitor and moving parents", async () => {
    await register("/external/main");
    const { name } = await registerMain();
    await updateWorkspaces(mainWorktree, registryDir, (registry) => {
      delete registry.workspaces.main;
      Object.assign(registry.workspaces[name], {
        status: "ready",
        devSetupAt: CREATED_AT,
        runFilesWrittenWith: { ports: {}, inputs: {} },
      });
    });
    const moved = join(root, "parent", "main");
    mkdirSync(join(root, "parent"));
    renameSync(mainWorktree, moved);
    mainWorktree = moved;
    expect(await registerMain()).toEqual({ name, status: "ready" });
    expect(readEntries()[name].devSetupAt).toBe(CREATED_AT);
    expect(readEntries()[name].runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
  });

  it("reconciles an actual rename before an unrelated write can discard its evidence", async () => {
    writeStored(
      {
        old: {
          ...entry("/previous/old"),
          main: true,
          ports: { web: 8200 },
          devSetupAt: CREATED_AT,
          runFilesWrittenWith: { ports: {}, inputs: {} },
          purgeData: { volume: "legacy" },
        },
        main: entry("/linked/main"),
      },
      2,
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateWorkspaces(mainWorktree, registryDir, (registry) => {
        registry.workspaces.other = entry("/linked/other");
      });
      const name = `main-${digestOf(mainWorktree).slice(0, 8)}`;
      expect(readEntries().main.worktree).toBe("/linked/main");
      expect(readEntries()[name]).toEqual({
        ...entry(mainWorktree),
        main: true,
        ports: { web: 8200 },
        purgeData: { volume: "legacy" },
      });
      expect(warn.mock.calls.join("\n")).toContain(`renamed from "old" to "${name}"`);
      expect((await registerMain()).name).toBe(name);
    } finally {
      warn.mockRestore();
    }
  });

  it("updates by path when the captured main name was reconciled and then reused by a foreign path", async () => {
    writeStored({ old: { ...entry("/previous/old", "pending"), main: true } }, 2);
    const captured = findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), mainWorktree);
    expect(captured?.name).toBe("old");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateWorkspaces(mainWorktree, registryDir, (registry) => {
        registry.workspaces.old = entry("/foreign/old", "failed");
      });
      await markWorkspaceReady(mainWorktree, registryDir, mainWorktree);
      expect(readEntries().main.status).toBe("ready");
      expect(readEntries().old.status).toBe("failed");
      await markWorkspaceFailed(mainWorktree, registryDir, mainWorktree, "boom");
      expect(readEntries().main.failure?.message).toBe("boom");
      expect(readEntries().old.failure).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves infrastructure state when a real rename leaves the registered name unchanged", async () => {
    writeStored(
      {
        main: {
          ...entry("/previous/different-basename"),
          main: true,
          devSetupAt: CREATED_AT,
          runFilesWrittenWith: { ports: {}, inputs: {} },
        },
      },
      2,
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await registerMain()).name).toBe("main");
      expect(readEntries().main.devSetupAt).toBe(CREATED_AT);
      expect(readEntries().main.runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("retains the winning duplicate's original path until rename reconciliation", async () => {
    writeStored(
      {
        older: { ...entry("/prior/older"), main: true },
        newest: { ...entry("/prior/newest"), main: true, createdAt: "2026-09-01T00:00:00.000Z" },
      },
      2,
    );
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateWorkspaces(mainWorktree, registryDir, () => {});
      expect(Object.keys(readEntries())).toEqual(["main"]);
      expect(readEntries().main.createdAt).toBe("2026-09-01T00:00:00.000Z");
      expect(warn.mock.calls.join("\n")).toContain('renamed from "newest"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveCurrentWorkspace", () => {
  it("resolves the entry whose worktree is the cwd", () => {
    const cwd = process.cwd();
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { here: entry(cwd), elsewhere: entry("/repo/wt-b") },
    });
    const resolved = resolveCurrentWorkspace(mainWorktree, registryDir, cwd);
    expect(resolved).toEqual({ name: "here", worktree: cwd });
  });
});
