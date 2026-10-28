import { createHash } from "node:crypto";
import {
  existsSync,
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
let root: string;
let mainWorktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspaces-"));
  mainWorktree = join(root, "main");
  mkdirSync(mainWorktree);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function entry(worktree: string, status: WorkspaceEntry["status"] = "ready"): WorkspaceEntry {
  return { worktree, createdAt: CREATED_AT, status, recipe: { kind: "defaults" } };
}

function register(worktree: string, overrides: Partial<RegisterWorkspaceInput> = {}) {
  return registerWorkspace({
    currentWorktree: worktree,
    mainWorktree,
    registryDir,
    isMainWorktree: worktree === mainWorktree,
    recipe: { kind: "defaults" },
    ...overrides,
  });
}

function stored() {
  return readFileSync(workspacesFilePath(mainWorktree, registryDir), "utf8");
}

function entries() {
  return readWorkspaces(mainWorktree, registryDir).workspaces;
}

function raw(value: Record<string, unknown>) {
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(
    workspacesFilePath(mainWorktree, registryDir),
    JSON.stringify({
      storage: { in: "project", mainWorktree, registryDir: join(mainWorktree, registryDir) },
      runtimeOwners: {},
      ...value,
    }),
  );
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("workspace registration", () => {
  it("stores version 4, required provenance and pending preparation without allocating ports", async () => {
    expect(registryDir).toBe(".local-wt/workspace-registry");
    expect(readWorkspaces(mainWorktree, registryDir).workspaces).toEqual({});
    expect(existsSync(join(mainWorktree, registryDir))).toBe(false);
    expect(await register("/repo/wt-a")).toEqual({ name: "wt-a", status: "pending" });
    expect(JSON.parse(stored())).toEqual({
      version: 4,
      storage: { in: "project", mainWorktree, registryDir: join(mainWorktree, registryDir) },
      runtimeOwners: {},
      workspaces: {
        "wt-a": {
          ...entry("/repo/wt-a", "pending"),
          createdAt: expect.any(String),
        },
      },
    });
    expect(readdirSync(join(mainWorktree, registryDir))).toEqual(["workspaces.json"]);
  });

  it("preserves creation, allocation, fingerprints and ready state, clearing only the previous dev failure", async () => {
    const basis = { ports: { web: 8200 }, inputs: { host: `sha256:${digest("localhost")}` } };
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        wt: {
          ...entry("/repo/wt"),
          ports: basis.ports,
          runFilesWrittenWith: basis,
          devSetupAt: CREATED_AT,
          devSetupFailure: { at: CREATED_AT, message: "old" },
        },
      },
    });
    expect(await register("/repo/wt")).toEqual({ name: "wt", status: "ready" });
    expect(entries().wt).toEqual({
      ...entry("/repo/wt"),
      ports: basis.ports,
      runFilesWrittenWith: basis,
      devSetupAt: CREATED_AT,
    });
    expect((await register("/repo/wt", { force: true })).status).toBe("pending");
    await markWorkspaceFailed(mainWorktree, registryDir, "/repo/wt", "retry");
    expect(entries().wt.failure?.message).toBe("retry");
    expect((await register("/repo/wt")).status).toBe("pending");
    expect(entries().wt.failure).toBeUndefined();
    await markWorkspaceReady(mainWorktree, registryDir, "/repo/wt");
    expect(entries().wt.status).toBe("ready");
  });

  it("finalizes main entries created by dev setup and flags main registration", async () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        main: {
          ...entry(mainWorktree),
          main: true,
          neverFinalized: true,
        },
      },
    });
    expect(await register(mainWorktree)).toEqual({ name: "main", status: "pending" });
    expect(entries().main.main).toBe(true);
    expect(entries().main.neverFinalized).toBeUndefined();
  });

  it("refuses a missing registered manifest, allowing an extension-only switch", async () => {
    const json = join(mainWorktree, "alignfirst.json");
    writeFileSync(json, '{"schemaVersion":1}');
    await register(mainWorktree, {
      recipe: { kind: "manifest", file: "alignfirst.json", in: "project" },
    });
    expect(entries().main.recipe).toEqual({
      kind: "manifest",
      file: "alignfirst.json",
      in: "project",
    });
    renameSync(json, `${json}c`);
    await register(mainWorktree, {
      recipe: { kind: "manifest", file: "alignfirst.jsonc", in: "project" },
    });
    expect(entries().main.recipe).toEqual({
      kind: "manifest",
      file: "alignfirst.jsonc",
      in: "project",
    });
    await expect(
      register(mainWorktree, {
        recipe: { kind: "manifest", file: "alignfirst.json", in: "companion" },
      }),
    ).rejects.toThrow("source changed");
    rmSync(`${json}c`);
    const before = stored();
    await expect(register(mainWorktree)).rejects.toThrow("manifest recipe is missing");
    expect(stored()).toBe(before);
    await markWorkspaceFailed(mainWorktree, registryDir, mainWorktree, "repair");
    expect(entries().main.recipe.kind).toBe("manifest");
  });
});

describe("registry format rejection", () => {
  it("refuses a retired slot registry rather than registering an apparently empty project", async () => {
    mkdirSync(join(mainWorktree, registryDir), { recursive: true });
    const retired = join(mainWorktree, registryDir, "slots.json");
    writeFileSync(retired, '{"old":"identity"}');
    await expect(register(mainWorktree)).rejects.toThrow("Unsupported retired registry");
    expect(readFileSync(retired, "utf8")).toBe('{"old":"identity"}');
    expect(existsSync(workspacesFilePath(mainWorktree, registryDir))).toBe(false);
  });

  it.each([undefined, 1, 2, 3])("rejects version %s before any mutation", async (version) => {
    raw({ version, workspaces: { old: entry("/old/wt") } });
    const before = stored();
    expect(() => entries()).toThrow("unsupported registry");
    await expect(register(mainWorktree)).rejects.toThrow("unsupported registry");
    expect(stored()).toBe(before);
  });

  it.each([
    { worktree: "/old/wt", createdAt: CREATED_AT, status: "ready" },
    { ...entry("/old/wt"), portIndex: 2 },
    { ...entry("/old/wt"), purgeData: {} },
    {
      ...entry("/old/wt"),
      recipe: { kind: "manifest", file: "alignfirst-workspace.json", in: "project" },
    },
    { ...entry("/old/wt"), recipe: { kind: "manifest", file: "alignfirst.json" } },
    entry("../relative"),
    entry("/old/../noncanonical"),
    { ...entry("/old/wt"), runFilesWrittenWith: { ports: {}, inputs: { secret: "plaintext" } } },
  ])(
    "preserves bytes for missing provenance, retired fields and malformed entries",
    async (invalid) => {
      raw({ version: 4, workspaces: { old: invalid } });
      const before = stored();
      await expect(register(mainWorktree)).rejects.toThrow();
      expect(stored()).toBe(before);
    },
  );

  it("rejects malformed JSON and duplicate identities rather than repairing them", async () => {
    raw({
      version: 4,
      workspaces: { a: { ...entry("/old/a"), main: true }, b: { ...entry("/old/b"), main: true } },
    });
    const before = stored();
    await expect(updateWorkspaces(mainWorktree, registryDir, () => {})).rejects.toThrow(
      "duplicate",
    );
    expect(stored()).toBe(before);
    writeFileSync(workspacesFilePath(mainWorktree, registryDir), "{broken");
    await expect(register(mainWorktree)).rejects.toThrow("unsupported registry");
    expect(stored()).toBe("{broken");
  });

  it("does not invent devSetupAt or repair missing linked paths from basenames", () => {
    mkdirSync(join(root, "wt"));
    raw({ version: 4, workspaces: { wt: entry("/missing/external/wt") } });
    expect(entries().wt).toEqual(entry("/missing/external/wt"));
  });
});

describe("collision-safe identity", () => {
  it("normalizes exact paths and preserves suffixes after competitors disappear", async () => {
    await register("/first/wt");
    const second = await register("/second/wt");
    expect(second.name).toBe(`wt-${digest("/second/wt").slice(0, 8)}`);
    await updateWorkspaces(mainWorktree, registryDir, (registry) => {
      delete registry.workspaces.wt;
    });
    expect(await register("/second/other/../wt")).toEqual(second);
    expect(
      findWorkspaceByPath(readWorkspaces(mainWorktree, registryDir), "/second/./wt")?.name,
    ).toBe(second.name);
  });

  it("allocates atomically across concurrent registrations", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `/external/${index}/wt`);
    const results = await Promise.all(paths.map((path) => register(path)));
    expect(new Set(results.map((result) => result.name)).size).toBe(paths.length);
    expect(
      Object.values(entries())
        .map((value) => value.worktree)
        .sort(),
    ).toEqual(paths.sort());
  });

  it("extends occupied hash candidates and falls back beyond the full digest without overwrites", async () => {
    const path = "/second/wt";
    const hash = digest(path);
    const reserved: Record<string, WorkspaceEntry> = { wt: entry("/first/wt") };
    reserved[`wt-${hash.slice(0, 8)}`] = entry("/occupied/8");
    expect(allocateWorkspaceName(reserved, path)).toBe(`wt-${hash.slice(0, 9)}`);
    for (let length = 9; length <= hash.length; ++length)
      reserved[`wt-${hash.slice(0, length)}`] = entry(`/occupied/${length}`);
    reserved[`wt-${hash}-2`] = entry("/occupied/numeric");
    writeWorkspaces(mainWorktree, registryDir, { workspaces: reserved });
    expect((await register(path)).name).toBe(`wt-${hash}-3`);
    for (const [name, value] of Object.entries(reserved)) expect(entries()[name]).toEqual(value);
  });

  it("allocates main/linked collisions in either registration order", async () => {
    await register("/external/main");
    const main = await register(mainWorktree);
    expect(main.name).toBe(`main-${digest(mainWorktree).slice(0, 8)}`);
    expect(entries()[main.name].main).toBe(true);
    writeWorkspaces(mainWorktree, registryDir, { workspaces: {} });
    expect((await register(mainWorktree)).name).toBe("main");
    expect((await register("/external/main")).name).toMatch(/^main-[a-f0-9]{8}$/);
  });
});

describe("main relocation and re-key", () => {
  it("preserves a suffixed identity and setup state on a parent-only move", async () => {
    await register("/external/main");
    const { name } = await register(mainWorktree);
    await updateWorkspaces(mainWorktree, registryDir, (registry) => {
      delete registry.workspaces.main;
      Object.assign(registry.workspaces[name], {
        status: "ready",
        devSetupAt: CREATED_AT,
        runFilesWrittenWith: { ports: {}, inputs: {} },
      });
    });
    mkdirSync(join(root, "parent"));
    const moved = join(root, "parent", "main");
    renameSync(mainWorktree, moved);
    mainWorktree = moved;
    expect(await register(mainWorktree)).toEqual({ name, status: "ready" });
    expect(entries()[name].devSetupAt).toBe(CREATED_AT);
    expect(entries()[name].runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
  });

  it("reconciles genuine rename evidence on any write, retaining ports and provenance", async () => {
    raw({
      version: 4,
      workspaces: {
        old: {
          ...entry("/previous/old"),
          main: true,
          ports: { web: 8200 },
          devSetupAt: CREATED_AT,
          runFilesWrittenWith: { ports: {}, inputs: {} },
        },
        main: entry("/linked/main"),
      },
    });
    const before = stored();
    expect(entries().old.worktree).toBe(mainWorktree);
    expect(stored()).toBe(before);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateWorkspaces(mainWorktree, registryDir, (registry) => {
        registry.workspaces.other = entry("/linked/other");
      });
      const name = `main-${digest(mainWorktree).slice(0, 8)}`;
      expect(entries().main.worktree).toBe("/linked/main");
      expect(entries()[name]).toEqual({ ...entry(mainWorktree), main: true, ports: { web: 8200 } });
      expect(warn.mock.calls.join("\n")).toContain(`renamed from "old" to "${name}"`);
      expect((await register(mainWorktree)).name).toBe(name);
    } finally {
      warn.mockRestore();
    }
  });

  it("fresh status updates act on paths after a captured name is re-keyed and reused", async () => {
    raw({ version: 4, workspaces: { old: { ...entry("/previous/old", "pending"), main: true } } });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateWorkspaces(mainWorktree, registryDir, (registry) => {
        registry.workspaces.old = entry("/foreign/old", "failed");
      });
      await markWorkspaceReady(mainWorktree, registryDir, mainWorktree);
      await markWorkspaceFailed(mainWorktree, registryDir, mainWorktree, "boom");
      expect(entries().main.failure?.message).toBe("boom");
      expect(entries().old).toEqual(entry("/foreign/old", "failed"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not invalidate setup when the registered name remains unchanged", async () => {
    raw({
      version: 4,
      workspaces: {
        main: {
          ...entry("/previous/different"),
          main: true,
          devSetupAt: CREATED_AT,
          runFilesWrittenWith: { ports: {}, inputs: {} },
        },
      },
    });
    expect((await register(mainWorktree)).name).toBe("main");
    expect(entries().main.devSetupAt).toBe(CREATED_AT);
    expect(entries().main.runFilesWrittenWith).toEqual({ ports: {}, inputs: {} });
  });
});

describe("path-scoped reads", () => {
  it("resolves identity and ports from exact paths without a basename fallback", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: {
        here: { ...entry("/repo/wt"), ports: { web: 8100 } },
        elsewhere: entry("/other/wt"),
      },
    });
    expect(resolveCurrentWorkspace(mainWorktree, registryDir, "/repo/wt")).toEqual({
      name: "here",
      worktree: "/repo/wt",
    });
    expect(storedPortsOf(mainWorktree, registryDir, "/repo/wt")).toEqual({ web: 8100 });
    expect(storedPortsOf(mainWorktree, registryDir, "/other/wt")).toEqual({});
    expect(storedPortsOf(mainWorktree, registryDir, "/unknown/wt")).toEqual({});
    expect(() => resolveCurrentWorkspace(mainWorktree, registryDir, "/unknown/wt")).toThrow(
      "No workspace",
    );
  });
});
