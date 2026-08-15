import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePortsConfig } from "../src/ports.js";
import {
  indexOfEntry,
  markWorkspaceReady,
  readWorkspaces,
  registerWorkspace,
  registryDirFor,
  type RegisterWorkspaceInput,
  resolveCurrentWorkspace,
  type WorkspaceEntry,
  writeWorkspaces,
} from "../src/workspaces.js";

const registryDir = registryDirFor(".local-wt");
const ports = resolvePortsConfig({ base: 8100, names: ["web"] });

let mainWorktree: string;

beforeEach(() => {
  mainWorktree = mkdtempSync(join(tmpdir(), "workspaces-"));
});

afterEach(() => {
  rmSync(mainWorktree, { recursive: true, force: true });
});

function entry(worktree: string, status: WorkspaceEntry["status"] = "ready"): WorkspaceEntry {
  return { worktree, createdAt: "2026-05-10T00:00:00.000Z", status };
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

/** Runs `fn`, expecting it to abort through `process.exit`; returns what it printed on stderr. */
function captureExit(fn: () => void): string {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("EXIT");
  }) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(fn).toThrow("EXIT");
    return error.mock.calls.map((args) => args.join(" ")).join("\n");
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}

describe("registryDirFor", () => {
  it("appends the workspace-registry subdir to runtimeDir", () => {
    expect(registryDirFor(".local-wt")).toBe(join(".local-wt", "workspace-registry"));
  });
});

describe("registerWorkspace", () => {
  it("keys the entry by the worktree directory basename", () => {
    const registered = register("/repo/myrepo-feat-a");
    expect(registered.name).toBe("myrepo-feat-a");
    expect(registered.status).toBe("pending");
    const registry = readWorkspaces(mainWorktree, registryDir);
    expect(Object.keys(registry.workspaces)).toEqual(["myrepo-feat-a"]);
    expect(registry.workspaces["myrepo-feat-a"].worktree).toBe("/repo/myrepo-feat-a");
  });

  it("flags the main worktree and stores no port index", () => {
    const { name, portIndex } = register(mainWorktree, { isMainWorktree: true, ports });
    expect(name).toBe(basename(mainWorktree));
    expect(portIndex).toBeUndefined();
    expect(readWorkspaces(mainWorktree, registryDir).workspaces[name].main).toBe(true);
  });

  it("refuses a name already taken by another worktree", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "myrepo-feat-a": entry("/elsewhere/myrepo-feat-a") },
    });
    const message = captureExit(() => register("/repo/myrepo-feat-a"));
    expect(message).toContain("already taken by /elsewhere/myrepo-feat-a");
  });

  it("keeps createdAt, extra and a ready status across a re-register", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": { ...entry("/repo/wt-a"), extra: { container: "db-wt-a" } } },
    });
    const registered = register("/repo/wt-a");
    expect(registered.status).toBe("ready");
    const stored = readWorkspaces(mainWorktree, registryDir).workspaces["wt-a"];
    expect(stored.createdAt).toBe("2026-05-10T00:00:00.000Z");
    expect(stored.extra).toEqual({ container: "db-wt-a" });
  });

  it("resets a ready workspace to pending with `force`", () => {
    writeWorkspaces(mainWorktree, registryDir, { workspaces: { "wt-a": entry("/repo/wt-a") } });
    expect(register("/repo/wt-a", { force: true }).status).toBe("pending");
  });

  it("allocates the lowest free port index, main worktree excluded", () => {
    expect(register("/repo/wt-a", { ports }).portIndex).toBe(1);
    expect(register("/repo/wt-b", { ports }).portIndex).toBe(2);
    const registry = readWorkspaces(mainWorktree, registryDir);
    delete registry.workspaces["wt-a"];
    writeWorkspaces(mainWorktree, registryDir, registry);
    expect(register("/repo/wt-c", { ports }).portIndex).toBe(1);
  });

  it("reuses the port index of an already registered worktree", () => {
    register("/repo/wt-a", { ports });
    const second = register("/repo/wt-b", { ports });
    expect(register("/repo/wt-b", { ports, force: true }).portIndex).toBe(second.portIndex);
  });

  it("allocates no port index in portless mode", () => {
    expect(register("/repo/wt-a").portIndex).toBeUndefined();
    expect(readWorkspaces(mainWorktree, registryDir).workspaces["wt-a"].portIndex).toBeUndefined();
  });

  it("fails when every port index is taken", () => {
    const capped = resolvePortsConfig({ base: 8100, maxWorkspaces: 3, names: ["web"] });
    register("/repo/wt-a", { ports: capped });
    register("/repo/wt-b", { ports: capped });
    const message = captureExit(() => register("/repo/wt-c", { ports: capped }));
    expect(message).toContain("All 3 port blocks are taken");
  });
});

describe("markWorkspaceReady", () => {
  it("marks the entry ready and persists the extra blob", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": entry("/repo/wt-a", "pending") },
    });
    markWorkspaceReady(mainWorktree, registryDir, "wt-a", { container: "db-wt-a" });
    const stored = readWorkspaces(mainWorktree, registryDir).workspaces["wt-a"];
    expect(stored.status).toBe("ready");
    expect(stored.extra).toEqual({ container: "db-wt-a" });
  });

  it("leaves a pre-existing extra untouched when none is passed", () => {
    writeWorkspaces(mainWorktree, registryDir, {
      workspaces: { "wt-a": { ...entry("/repo/wt-a", "pending"), extra: { volume: "v1" } } },
    });
    markWorkspaceReady(mainWorktree, registryDir, "wt-a");
    expect(readWorkspaces(mainWorktree, registryDir).workspaces["wt-a"].extra).toEqual({
      volume: "v1",
    });
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
    const resolved = resolveCurrentWorkspace(join(mainWorktree, registryDir));
    expect(resolved).toEqual({ name: "here", worktree: cwd });
  });
});
