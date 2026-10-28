import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevSetup, type DevSetupInput } from "../src/dev-setup.js";
import { createPreparationOwner, settlePreparationOwner } from "../src/preparation-ownership.js";
import * as startup from "../src/startup-ownership.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  registerWorkspace,
  updateWorkspaces,
  workspacesFilePath,
} from "../src/workspaces.js";

let root: string;
let input: DevSetupInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lifecycle-admission-"));
  const main = join(root, "main");
  mkdirSync(main);
  input = {
    worktree: { currentWorktree: main, mainWorktree: main, isMainWorktree: true },
    recipe: { kind: "defaults" },
    registryDir: join(main, ".local-wt/workspace-registry"),
    runtimeDir: join(main, ".local-wt"),
    runFiles: [],
    options: { force: true, resetPorts: false, fromFinalize: false, beforeStart: false },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("preparation and dev setup admission", () => {
  it("refuses forced workspace setup while explicit dev setup holds its hook", async () => {
    const entered = barrier();
    const release = barrier();
    input.setup = async () => {
      entered.release();
      await release.wait;
    };
    const running = runDevSetup(input);
    await entered.wait;
    const before = registryBytes();
    try {
      await expect(prepare()).rejects.toThrow(/startup/i);
      expect(registryBytes()).toBe(before);
    } finally {
      release.release();
      await running;
    }
  });

  it("rechecks preparation when explicit dev setup claims after its initial admission", async () => {
    const entered = barrier();
    const release = barrier();
    const claim = startup.claimStartup;
    vi.spyOn(startup, "claimStartup").mockImplementation(async (...args) => {
      entered.release();
      await release.wait;
      return claim(...args);
    });
    const hook = vi.fn();
    input.setup = hook;
    const running = runDevSetup(input);
    const rejected = expect(running).rejects.toThrow(/preparation/i);
    await entered.wait;
    try {
      await prepare();
    } finally {
      release.release();
    }
    await rejected;
    expect(hook).not.toHaveBeenCalled();
    expect(
      startup.readStartupOwners(input.worktree.mainWorktree, input.registryDir).owners,
    ).toEqual([]);
    expect(currentEntry()?.preparationOwner).toBeDefined();
  });

  it("requires explicit cleanup rather than replacing an abandoned startup with preparation", async () => {
    await runDevSetup(input);
    const owner = await startup.claimStartup(
      input.worktree.mainWorktree,
      input.registryDir,
      input.worktree.currentWorktree,
    );
    writeFileSync(
      join(input.registryDir, "dev-startups.json"),
      JSON.stringify({ version: 1, owners: [{ ...owner, pid: 2147483647 }] }),
    );
    await expect(prepare()).rejects.toThrow(/startup/i);
    expect(currentEntry()?.preparationOwner).toBeUndefined();
  });

  it("rejects startup and finalizer dev setup under abandoned preparation", async () => {
    const owner = createPreparationOwner();
    await prepare(owner);
    await updateWorkspaces(input.worktree.mainWorktree, input.registryDir, (registry) => {
      const entry = findWorkspaceByPath(registry, input.worktree.currentWorktree)?.entry;
      if (entry?.preparationOwner) entry.preparationOwner.pid = 2147483647;
    });
    await expect(
      startup.claimStartup(
        input.worktree.mainWorktree,
        input.registryDir,
        input.worktree.currentWorktree,
      ),
    ).rejects.toThrow(/preparation/i);
    input.options = { ...input.options, fromFinalize: true, preparationToken: owner.token };
    input.setup = vi.fn();
    await expect(runDevSetup(input)).rejects.toThrow(/preparation/i);
    expect(input.setup).not.toHaveBeenCalled();
  });

  it("allows only a live matching finalizer token, and never revives an invalidated token", async () => {
    const owner = createPreparationOwner();
    await prepare(owner);
    input.options = { ...input.options, fromFinalize: true, preparationToken: owner.token };
    const hook = vi.fn();
    input.setup = hook;
    await runDevSetup(input);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(currentEntry()?.preparationOwner).toEqual(owner);

    input.options.preparationToken = "wrong-token";
    await expect(runDevSetup(input)).rejects.toThrow(/preparation/i);
    input.options.preparationToken = owner.token;
    await settlePreparationOwner(
      input.worktree.mainWorktree,
      input.registryDir,
      input.worktree.currentWorktree,
      owner,
      { status: "ready" },
    );
    await expect(runDevSetup(input)).rejects.toThrow(/preparation/i);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function prepare(owner = createPreparationOwner()) {
  return registerWorkspace({
    ...input.worktree,
    registryDir: input.registryDir,
    recipe: input.recipe,
    force: true,
    preparationOwner: owner,
  });
}

function registryBytes(): string {
  return readFileSync(workspacesFilePath(input.worktree.mainWorktree, input.registryDir), "utf8");
}

function currentEntry() {
  return findWorkspaceByPath(
    readWorkspaces(input.worktree.mainWorktree, input.registryDir),
    input.worktree.currentWorktree,
  )?.entry;
}
