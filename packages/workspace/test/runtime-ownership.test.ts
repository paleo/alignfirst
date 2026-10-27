import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readDevServers } from "../src/dev-servers-registry.js";
import { setupLogPath, setupProgressPath } from "../src/helpers.js";
import { workspaceCandidatePaths } from "../src/inventory.js";
import {
  adoptPreparationOwner,
  createPreparationOwner,
  recoverPreparationForCleanup,
  settlePreparationOwner,
} from "../src/preparation-ownership.js";
import { withRegistryLock } from "../src/registry-lock.js";
import {
  assertRuntimeOwnership,
  claimRuntime,
  claimRuntimeDisposal,
  disposeRuntime,
  inspectKnownWorkspaceState,
  releaseRuntimeResources,
  retainedRuntime,
} from "../src/runtime-ownership.js";
import {
  assertStartupOwner,
  claimStartup,
  readStartupOwners,
  releaseStartup,
} from "../src/startup-ownership.js";
import {
  resolveWorkspaceStorage,
  runtimeDirForTarget,
  type WorkspaceStorage,
} from "../src/storage.js";
import {
  findWorkspaceByPath,
  readWorkspaces,
  registerWorkspace,
  updateWorkspaces,
  workspacesFilePath,
  type RuntimeOwner,
  type OwnershipClaim,
} from "../src/workspaces.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

let root: string;
let main: string;
let storage: WorkspaceStorage;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "runtime-ownership-"));
  main = join(root, "main");
  mkdirSync(main);
  storage = resolveWorkspaceStorage(
    { in: "companion", mainWorktree: main, companionDir: join(root, "companion") },
    join(root, "one", "target"),
  );
  const real = await vi.importActual<typeof fsPromises>("node:fs/promises");
  vi.mocked(fsPromises.rm).mockReset().mockImplementation(real.rm);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function activeTarget(
  target = storage,
  preparationOwner?: OwnershipClaim,
): Promise<RuntimeOwner> {
  const runtime = await claimRuntime(target);
  if (!runtime) throw new Error("Expected external runtime");
  await registerWorkspace({
    currentWorktree: target.currentWorktree,
    mainWorktree: main,
    registryDir: target.registryDir,
    isMainWorktree: target.currentWorktree === main,
    recipe: { kind: "defaults" },
    preparationOwner,
  });
  mkdirSync(join(target.runtimeDir, "logs"), { recursive: true });
  writeFileSync(join(target.runtimeDir, "logs", "kept.log"), "evidence");
  return runtime;
}

async function cleanTarget(
  generation: string,
  mode: "retain" | "delete" = "retain",
): Promise<void> {
  await updateWorkspaces(main, storage.registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, storage.currentWorktree)?.entry;
    if (entry) {
      entry.cleanupPending = true;
      entry.ports = { web: 8210 };
    }
  });
  await releaseRuntimeResources(storage, generation, mode);
}

function registryBytes(): string {
  return readFileSync(workspacesFilePath(main, storage.registryDir), "utf8");
}

describe("external runtime ownership", () => {
  it("uses one absolute registry and distinct owned directories for same-basename targets", async () => {
    expect(readWorkspaces(main, storage.registryDir).workspaces).toEqual({});
    expect(existsSync(join(root, "companion"))).toBe(false);
    const sibling = resolveWorkspaceStorage(storage, join(root, "two", "target"));
    const first = await activeTarget();
    const second = await activeTarget(sibling);
    expect(first.runtimeDir).not.toBe(second.runtimeDir);
    expect(storage.registryDir).toBe(sibling.registryDir);
    expect(readdirSync(storage.registryDir)).toEqual(["workspaces.json"]);
    const stored = JSON.parse(registryBytes());
    expect(stored).toMatchObject({
      version: 4,
      storage: { in: "companion", mainWorktree: main, registryDir: storage.registryDir },
    });
    expect(Object.keys(stored.runtimeOwners)).toEqual([
      basename(first.runtimeDir),
      basename(second.runtimeDir),
    ]);
    expect(existsSync(join(main, ".local-wt"))).toBe(false);
    expect(existsSync(join(first.runtimeDir, "workspace-registry"))).toBe(false);
    expect(runtimeDirForTarget({ runtimeDir: ".local-wt", storage }, sibling.currentWorktree)).toBe(
      second.runtimeDir,
    );
    expect(setupLogPath(second.runtimeDir)).toBe(
      join(second.runtimeDir, "logs/workspace-setup.log"),
    );
    expect(setupProgressPath(second.runtimeDir)).toBe(
      join(second.runtimeDir, "logs/workspace-setup.progress"),
    );
  });

  it("rejects a foreign repository even with an empty workspace map before sidecar reads or locks", async () => {
    await claimRuntime(storage);
    const foreign = join(root, "other-main");
    mkdirSync(foreign);
    const before = registryBytes();
    expect(() => readDevServers(foreign, storage.registryDir)).toThrow(/foreign|ownership/);
    await expect(withRegistryLock(foreign, storage.registryDir, () => {})).rejects.toThrow(
      /foreign|ownership/,
    );
    expect(registryBytes()).toBe(before);
    expect(readdirSync(storage.registryDir)).toEqual(["workspaces.json"]);
  });

  it("releases names and ports while preserving clean runtime-only inventory and retained files", async () => {
    const runtime = await activeTarget();
    await cleanTarget(runtime.generation);
    const registry = readWorkspaces(main, storage.registryDir);
    expect(registry.workspaces).toEqual({});
    expect(registry.runtimeOwners?.[basename(storage.runtimeDir)]).toMatchObject({
      state: "retained",
      generation: runtime.generation,
    });
    expect(workspaceCandidatePaths([main], registry)).toEqual([main, storage.currentWorktree]);
    expect(inspectKnownWorkspaceState(main, storage.registryDir)).toMatchObject({
      requiresCleanup: false,
      retainedWorktrees: [storage.currentWorktree],
    });
    expect(readFileSync(join(storage.runtimeDir, "logs/kept.log"), "utf8")).toBe("evidence");
  });

  it("atomically hands cleanup to deletionPending, blocking re-adoption before a disposal claim", async () => {
    const runtime = await activeTarget();
    await cleanTarget(runtime.generation, "delete");
    expect(readWorkspaces(main, storage.registryDir).workspaces).toEqual({});
    expect(inspectKnownWorkspaceState(main, storage.registryDir).requiresCleanup).toBe(true);
    await expect(releaseRuntimeResources(storage, runtime.generation, "retain")).rejects.toThrow(
      /deletion pending/i,
    );
    await expect(claimRuntime(storage)).rejects.toThrow(/deletion pending/i);
    await expect(claimStartup(main, storage.registryDir, storage.currentWorktree)).rejects.toThrow(
      /deletion pending/i,
    );
    const disposal = await claimRuntimeDisposal(storage, runtime.generation);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "data"), "protected");
    symlinkSync(outside, join(storage.runtimeDir, "application-link"));
    await expect(claimRuntimeDisposal(storage, runtime.generation)).rejects.toThrow(/owned/);
    await expect(
      registerWorkspace({
        currentWorktree: storage.currentWorktree,
        mainWorktree: main,
        registryDir: storage.registryDir,
        isMainWorktree: false,
        recipe: { kind: "defaults" },
      }),
    ).rejects.toThrow(/deletion pending/i);
    await disposeRuntime(disposal);
    expect(existsSync(storage.runtimeDir)).toBe(false);
    expect(readFileSync(join(outside, "data"), "utf8")).toBe("protected");
    expect(existsSync(storage.registryDir)).toBe(true);
    expect(readWorkspaces(main, storage.registryDir).runtimeOwners).toEqual({});
  });

  it("retains identity after partial deletion and retries an already-missing directory without touching siblings", async () => {
    const runtime = await activeTarget();
    const sibling = resolveWorkspaceStorage(storage, join(root, "two/target"));
    await activeTarget(sibling);
    await cleanTarget(runtime.generation, "delete");
    const disposal = await claimRuntimeDisposal(storage, runtime.generation);
    vi.mocked(fsPromises.rm).mockImplementationOnce(async () => {
      rmSync(join(storage.runtimeDir, "logs"), { recursive: true });
      throw new Error("partial filesystem failure");
    });
    await expect(disposeRuntime(disposal)).rejects.toThrow("partial filesystem failure");
    expect(retainedRuntime(storage)).toMatchObject({
      state: "deletionPending",
      generation: runtime.generation,
    });
    expect(retainedRuntime(storage)?.deletionClaim).toBeUndefined();
    rmSync(storage.runtimeDir, { recursive: true });
    await disposeRuntime(await claimRuntimeDisposal(storage, runtime.generation));
    expect(readFileSync(join(sibling.runtimeDir, "logs/kept.log"), "utf8")).toBe("evidence");
  });

  it("rejects a stale cleaned generation after retained storage is re-adopted", async () => {
    const old = await activeTarget();
    await cleanTarget(old.generation);
    const replacement = await claimRuntime(storage);
    expect(replacement?.generation).not.toBe(old.generation);
    await expect(claimRuntimeDisposal(storage, old.generation)).rejects.toThrow(
      /generation changed/,
    );
    expect(readFileSync(join(storage.runtimeDir, "logs/kept.log"), "utf8")).toBe("evidence");
  });

  it("keeps cancelled disposal pending and releases only its caller claim", async () => {
    const runtime = await activeTarget();
    await cleanTarget(runtime.generation, "delete");
    const disposal = await claimRuntimeDisposal(storage, runtime.generation);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(disposeRuntime(disposal, controller.signal)).rejects.toThrow("cancelled");
    expect(retainedRuntime(storage)?.deletionClaim).toBeUndefined();
    expect(existsSync(storage.runtimeDir)).toBe(true);
    await disposeRuntime(await claimRuntimeDisposal(storage, runtime.generation));
  });

  it("recovers dead deletion ownership without allowing stale completion to erase a live claim", async () => {
    const runtime = await activeTarget();
    await cleanTarget(runtime.generation, "delete");
    const deadPid = exitedPid();
    await updateWorkspaces(main, storage.registryDir, (registry) => {
      const owner = registry.runtimeOwners?.[basename(storage.runtimeDir)];
      if (owner) owner.deletionClaim = { pid: deadPid, token: "old" };
    });
    const replacement = await claimRuntimeDisposal(storage, runtime.generation);
    await expect(
      disposeRuntime({ ...replacement, claim: { pid: deadPid, token: "old" } }),
    ).rejects.toThrow(/ownership lost/);
    expect(retainedRuntime(storage)?.deletionClaim).toEqual(replacement.claim);
    await disposeRuntime(replacement);
  });
});

describe("preparation and startup cleanup exclusion", () => {
  it("refuses a live orphan preparation and invalidates dead child handoff before cleanup releases it", async () => {
    const owner = createPreparationOwner();
    const runtime = await activeTarget(storage, owner);
    await expect(releaseRuntimeResources(storage, runtime.generation, "delete")).rejects.toThrow(
      /Live preparation/,
    );
    const deadPid = exitedPid();
    await updateWorkspaces(main, storage.registryDir, (registry) => {
      const entry = findWorkspaceByPath(registry, storage.currentWorktree)?.entry;
      if (entry) entry.preparationOwner = { ...owner, pid: deadPid };
    });
    await expect(
      registerWorkspace({
        currentWorktree: storage.currentWorktree,
        mainWorktree: main,
        registryDir: storage.registryDir,
        isMainWorktree: false,
        recipe: { kind: "defaults" },
      }),
    ).rejects.toThrow(/abandoned/);
    await updateWorkspaces(main, storage.registryDir, (registry) => {
      const entry = findWorkspaceByPath(registry, storage.currentWorktree)?.entry;
      if (entry) recoverPreparationForCleanup(entry);
    });
    await expect(
      adoptPreparationOwner(main, storage.registryDir, storage.currentWorktree, owner.token),
    ).rejects.toThrow(/ownership lost/);
    await releaseRuntimeResources(storage, runtime.generation, "delete");
    await disposeRuntime(await claimRuntimeDisposal(storage, runtime.generation));
  });

  it("requires the matching preparation claim to settle and clears it on success", async () => {
    const owner = createPreparationOwner();
    await activeTarget(storage, owner);
    expect(
      findWorkspaceByPath(readWorkspaces(main, storage.registryDir), storage.currentWorktree)?.entry
        .preparationOwner,
    ).toEqual(owner);
    const adopted = await adoptPreparationOwner(
      main,
      storage.registryDir,
      storage.currentWorktree,
      owner.token,
    );
    await expect(
      settlePreparationOwner(
        main,
        storage.registryDir,
        storage.currentWorktree,
        { ...adopted, token: "wrong" },
        { status: "ready" },
      ),
    ).rejects.toThrow(/ownership lost/);
    await settlePreparationOwner(main, storage.registryDir, storage.currentWorktree, adopted, {
      status: "ready",
    });
    expect(
      findWorkspaceByPath(readWorkspaces(main, storage.registryDir), storage.currentWorktree)?.entry
        .preparationOwner,
    ).toBeUndefined();
  });

  it("refuses live startup ownership and invalidates abandoned tokens on cleanup-to-disposal handoff", async () => {
    const runtime = await activeTarget();
    const live = await claimStartup(main, storage.registryDir, storage.currentWorktree);
    await expect(cleanTarget(runtime.generation, "delete")).rejects.toThrow(/Live startup/);
    await releaseStartup(main, storage.registryDir, live);
    const abandoned = { ...live, pid: exitedPid() };
    writeFileSync(
      join(storage.registryDir, "dev-startups.json"),
      JSON.stringify({ version: 1, owners: [abandoned] }),
    );
    await cleanTarget(runtime.generation, "delete");
    expect(readStartupOwners(main, storage.registryDir).owners).toEqual([]);
    expect(() => assertStartupOwner(main, storage.registryDir, abandoned)).toThrow(
      /ownership lost/,
    );
  });
});

describe("external ownership boundaries", () => {
  it.each([false, true])(
    "refuses nonempty unowned runtime bytes with an existing registry: %s",
    async (existingRegistry) => {
      if (existingRegistry) await withRegistryLock(main, storage.registryDir, () => {});
      mkdirSync(storage.runtimeDir, { recursive: true });
      const evidence = join(storage.runtimeDir, "data");
      writeFileSync(evidence, "unaccounted");
      await expect(claimRuntime(storage)).rejects.toThrow(
        existingRegistry ? /Nonempty unowned runtime/ : /without their registry owner/,
      );
      expect(readFileSync(evidence, "utf8")).toBe("unaccounted");
      expect(existsSync(storage.registryDir)).toBe(existingRegistry);
    },
  );

  it("resolves a supported companion-root alias to the same registry owner", async () => {
    const runtime = await claimRuntime(storage);
    const alias = join(root, "companion-alias");
    symlinkSync(join(root, "companion"), alias);
    const selected = resolveWorkspaceStorage(
      { ...storage, companionDir: alias },
      storage.currentWorktree,
    );
    expect(selected.registryDir).toBe(storage.registryDir);
    expect(await claimRuntime(selected)).toEqual(runtime);
  });

  it("refuses symlinked runtime directories and registry sidecars while preserving foreign bytes", async () => {
    await claimRuntime(storage);
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "data"), "foreign bytes");
    mkdirSync(join(storage.registryDir, "../worktrees"), { recursive: true });
    symlinkSync(foreign, storage.runtimeDir);
    await expect(claimRuntime(storage)).rejects.toThrow(/ownership/);
    expect(readFileSync(join(foreign, "data"), "utf8")).toBe("foreign bytes");
    rmSync(storage.runtimeDir);
    mkdirSync(storage.runtimeDir);
    symlinkSync(foreign, join(storage.runtimeDir, "logs"));
    expect(() => assertRuntimeOwnership(storage)).toThrow(/ownership/);
    rmSync(join(storage.runtimeDir, "logs"));
    symlinkSync(join(foreign, "data"), join(storage.registryDir, "dev-startups.json"));
    expect(() => readDevServers(main, storage.registryDir)).toThrow(/ownership/);
    expect(readFileSync(join(foreign, "data"), "utf8")).toBe("foreign bytes");
  });

  it("rejects unexplained external relocation, duplicate destinations and obsolete provenance before sidecar reads", async () => {
    const runtime = await activeTarget();
    const original = registryBytes();
    const moved = {
      ...JSON.parse(original),
      storage: {
        in: "companion",
        mainWorktree: join(root, "old-main"),
        registryDir: storage.registryDir,
      },
    };
    writeFileSync(workspacesFilePath(main, storage.registryDir), JSON.stringify(moved));
    expect(() => readWorkspaces(main, storage.registryDir)).toThrow(/foreign|relocated/);
    const duplicate = JSON.parse(original);
    duplicate.runtimeOwners.other = runtime;
    writeFileSync(workspacesFilePath(main, storage.registryDir), JSON.stringify(duplicate));
    expect(() => readDevServers(main, storage.registryDir)).toThrow(/runtime ownership/);
    const obsolete = JSON.parse(original);
    Object.values<{ recipe: unknown }>(obsolete.workspaces)[0].recipe = {
      kind: "manifest",
      file: "alignfirst-workspace.json",
      in: "project",
    };
    const before = JSON.stringify(obsolete);
    writeFileSync(workspacesFilePath(main, storage.registryDir), before);
    expect(() => readDevServers(main, storage.registryDir)).toThrow(/unsupported registry/);
    expect(registryBytes()).toBe(before);
  });
});

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
  expect(child.status).toBe(0);
  return Number(child.stdout.trim());
}
