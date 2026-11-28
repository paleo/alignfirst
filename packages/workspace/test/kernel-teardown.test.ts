import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseDevArgs } from "../src/cli.js";
import { runDevServer } from "../src/dev-server.js";
import { WorkspaceError } from "../src/errors.js";
import { isProcessAlive } from "../src/process-control.js";
import { updateWorkspaces, type WorkspaceRecipe } from "../src/workspaces.js";
import {
  addWorktree,
  createKernelFixture,
  devEntries,
  devEntry,
  entryAt,
  failPurges,
  MANIFEST_RECIPE,
  sleeper,
  writeDevEntries,
  git,
  type KernelFixture,
  registryDir,
  removeKernelFixtures,
  requiredEntry,
  runKernel,
  workspaceConfig,
} from "./kernel-fixture.js";

const DEFAULTS: WorkspaceRecipe = { kind: "defaults" };
const MANIFEST = MANIFEST_RECIPE;

afterEach(removeKernelFixtures);

describe("teardown", () => {
  it("purges through the target's own selection and preserves its files and Git state", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "external/nested/same", "external");
    const versions: string[] = [];
    fx.config = workspaceConfig(fx.purges, {
      purgeInfrastructure: () => {
        versions.push("main");
      },
    });
    fx.configs.set(
      linked,
      workspaceConfig(fx.purges, {
        purgeInfrastructure: (ctx) => {
          versions.push(`target ${ctx.name} ${ctx.worktree}`);
        },
      }),
    );
    await runKernel(fx, ["setup"], { cwd: linked });
    const { name } = requiredEntry(fx, linked);
    writeFileSync(join(linked, "README.md"), "dirty tracked file\n");
    mkdirSync(join(linked, "node_modules"));
    writeFileSync(join(linked, "node_modules/retained"), "dependency");
    const before = preservationSnapshot(fx, linked);
    const nested = join(linked, "nested/inside");
    mkdirSync(nested, { recursive: true });
    await runKernel(fx, ["teardown", "--verbose"], { cwd: nested });
    expect(versions).toEqual([`target ${name} ${linked}`]);
    expect(preservationSnapshot(fx, linked)).toEqual(before);
    expect(entryAt(fx, linked)).toBeUndefined();
    await runKernel(fx, ["teardown", linked]);
    expect(versions).toHaveLength(1);
  });

  it("tears down main without dismantling the shared registry or a linked workspace", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "outside/review", "review");
    await runKernel(fx, ["setup"]);
    await runKernel(fx, ["setup"], { cwd: linked });
    const original = requiredEntry(fx, linked);
    const linkedDev = devEntry(original.name, linked, sleeper());
    writeDevEntries(fx, [devEntry("app", fx.repo), linkedDev]);
    const worktrees = git(fx.repo, "worktree", "list", "--porcelain");
    await expect(runKernel(fx, ["remove", "--force"])).rejects.toThrow(WorkspaceError);
    await runKernel(fx, ["teardown"]);
    expect(lstatSync(registryDir(fx)).isDirectory()).toBe(true);
    expect(entryAt(fx, fx.repo)).toBeUndefined();
    expect(entryAt(fx, linked)).toEqual(original);
    expect(realpathSync(join(linked, ".local-wt/workspace-registry"))).toBe(registryDir(fx));
    expect(realpathSync(join(linked, ".plans"))).toBe(join(fx.repo, ".plans"));
    expect(git(fx.repo, "worktree", "list", "--porcelain")).toBe(worktrees);
    await runKernel(fx, ["teardown"]);
    expect(fx.purges.map((ctx) => ctx.name)).toEqual(["app"]);
    expect(devEntries(fx)).toEqual([linkedDev]);
    expect(isProcessAlive(linkedDev.pids.app)).toBe(true);
  });

  it("stops every recorded main process", async () => {
    const fx = createKernelFixture();
    await runKernel(fx, ["setup"]);
    const pids = [sleeper(), sleeper()];
    writeDevEntries(fx, [
      { ...devEntry("app", fx.repo), main: true, pids: { app: pids[0], worker: pids[1] } },
    ]);
    await runKernel(fx, ["teardown"]);
    expect(pids.map(isProcessAlive)).toEqual([false, false]);
    expect(devEntries(fx)).toEqual([]);
    expect(entryAt(fx, fx.repo)).toBeUndefined();
    expect(fx.purges.map((ctx) => ctx.name)).toEqual(["app"]);
  });

  it("deletes by captured path when teardown is the first writer after a genuine main rename", async () => {
    const fx = createKernelFixture();
    await runKernel(fx, ["setup"]);
    const linked = addWorktree(fx, "linked/renamed", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    const other = requiredEntry(fx, linked);
    const renamed = join(fx.root, "renamed");
    renameSync(fx.repo, renamed);
    fx.repo = renamed;
    git(renamed, "worktree", "repair");
    await runKernel(fx, ["teardown"], { cwd: renamed });
    expect(entryAt(fx, renamed)).toBeUndefined();
    expect(entryAt(fx, linked)).toEqual(other);
    expect(fx.purges).toMatchObject([{ name: "app", worktree: renamed, mainWorktree: renamed }]);
  });

  it("purges a partial setup with its recorded name; a thrown purge retains registration", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "managed/review", "review");
    fx.config.gitignoredFiles = [
      {
        path: "required.local",
        source: { kind: "content", content: "" },
        patch: () => {
          throw new Error("seed failed");
        },
      },
    ];
    await expect(runKernel(fx, ["setup"], { cwd: linked })).rejects.toThrow("seed failed");
    const target = requiredEntry(fx, linked);
    expect(target.entry.status).toBe("failed");
    writeDevEntries(fx, [devEntry("stale-dev-name", linked)]);
    failPurges(fx, 1);
    await expect(runKernel(fx, ["teardown", linked])).rejects.toThrow("purge failed");
    const retained = requiredEntry(fx, linked);
    expect(retained.name).toBe(target.name);
    expect(retained.entry.cleanupPending).toBe(true);
    expect(retained.entry.cleanupOwner).toBeUndefined();
    expect(devEntries(fx)).toMatchObject([{ cleanupPending: true }]);
    await runKernel(fx, ["teardown", linked]);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(fx.purges.map((ctx) => [ctx.name, ctx.worktree])).toEqual([
      [target.name, linked],
      [target.name, linked],
    ]);
    expect(existsSync(linked)).toBe(true);
  });

  it("gates a ready workspace without dev records until purge succeeds, even after force or dev down", async () => {
    const fx = createKernelFixture();
    fx.config.hasDevServer = true;
    const linked = addWorktree(fx, "managed/retry", "retry");
    await runKernel(fx, ["setup"], { cwd: linked });
    const target = requiredEntry(fx, linked);
    failPurges(fx, 1);
    await expect(runKernel(fx, ["teardown", linked])).rejects.toThrow("purge failed");
    expect(requiredEntry(fx, linked).entry).toMatchObject({
      status: "ready",
      cleanupPending: true,
    });
    await expect(runKernel(fx, ["setup", "--force"], { cwd: linked })).rejects.toThrow();
    writeDevEntries(fx, [{ ...devEntry(target.name, linked), cleanupPending: true }]);
    let setups = 0;
    const dev = (args: string[]) =>
      runDevServer(
        { recipe: DEFAULTS, runtimeDir: ".local-wt", servers: [], setup: () => void ++setups },
        { ...fx.operation, cwd: linked, command: parseDevArgs(args) },
      );
    await dev(["down"]);
    expect(devEntries(fx)).toEqual([]);
    for (const args of [["setup", "--force"], ["up"]])
      await expect(dev(args)).rejects.toThrow(WorkspaceError);
    expect(setups).toBe(0);
    expect(requiredEntry(fx, linked).entry.cleanupPending).toBe(true);
    await runKernel(fx, ["teardown", linked]);
    expect(entryAt(fx, linked)).toBeUndefined();
    await runKernel(fx, ["setup"], { cwd: linked });
    await dev(["setup"]);
    expect(setups).toBe(1);
  });

  it("retains a durable dev-created identity of a missing worktree through purge failure", async () => {
    const fx = createKernelFixture();
    fx.config.recipe = MANIFEST;
    const linked = addWorktree(fx, "outside/review", "review");
    await recordIdentity(fx, linked, "recorded-infra");
    const pid = sleeper();
    writeDevEntries(fx, [devEntry("recorded-infra", linked, pid)]);
    rmSync(linked, { recursive: true, force: true });
    failPurges(fx, 1);
    await expect(runKernel(fx, ["teardown", linked])).rejects.toThrow("purge failed");
    expect(isProcessAlive(pid)).toBe(false);
    expect(devEntries(fx)).toMatchObject([{ cleanupPending: true }]);
    const retained = requiredEntry(fx, linked);
    expect(retained).toMatchObject({ name: "recorded-infra", entry: { status: "failed" } });
    await runKernel(fx, ["list"]);
    expect(requiredEntry(fx, linked)).toEqual(retained);
    await runKernel(fx, ["teardown", "recorded-infra"]);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(fx.purges.map((ctx) => ctx.name)).toEqual(["recorded-infra", "recorded-infra"]);
  });

  it("accepts only verified unregistered worktrees and never guesses a same-basename identity", async () => {
    const fx = createKernelFixture();
    const first = addWorktree(fx, "one/review", "one");
    const second = addWorktree(fx, "two/review", "two");
    await runKernel(fx, ["teardown"]);
    expect(existsSync(join(registryDir(fx), "workspaces.json"))).toBe(false);
    await runKernel(fx, ["setup"], { cwd: first });
    const original = requiredEntry(fx, first);
    await runKernel(fx, ["teardown", second]);
    const unrelated = createKernelFixture();
    const plain = join(fx.root, "plain/review");
    mkdirSync(plain, { recursive: true });
    for (const selector of ["typo", join(fx.root, "missing/review"), plain, unrelated.repo]) {
      await expect(runKernel(fx, ["teardown", selector])).rejects.toThrow(WorkspaceError);
      expect(requiredEntry(fx, first)).toEqual(original);
    }
    expect(fx.purges).toEqual([]);
  });

  it("checks both registries by path before names and preserves the workspace identity", async () => {
    const fx = createKernelFixture();
    fx.config.recipe = MANIFEST;
    const first = addWorktree(fx, "one/review", "one");
    const second = addWorktree(fx, "app/two/review", "two");
    await runKernel(fx, ["setup"], { cwd: first });
    await recordIdentity(fx, second, "dev-only-identity");
    const original = requiredEntry(fx, first);
    writeDevEntries(fx, [devEntry("dev-only-identity", second), devEntry("wrong-dev", first)]);
    await runKernel(fx, ["teardown", "review"], { cwd: dirname(second) });
    expect(fx.purges.map((ctx) => ctx.name)).toEqual(["dev-only-identity"]);
    expect(requiredEntry(fx, first)).toEqual(original);
    expect(devEntries(fx)).toEqual([devEntry("wrong-dev", first)]);
    await runKernel(fx, ["teardown", "wrong-dev"]);
    expect(fx.purges.map((ctx) => ctx.name)).toEqual(["dev-only-identity", original.name]);
    expect(devEntries(fx)).toEqual([]);
  });

  it("releases the name and ports for another worktree, and re-adoption prepares again", async () => {
    const fx = createKernelFixture();
    const first = addWorktree(fx, "one/review", "one");
    const second = addWorktree(fx, "two/review", "two");
    await runKernel(fx, ["setup"], { cwd: first });
    await updateWorkspaces(fx.repo, registryDir(fx), (registry) => {
      registry.workspaces.review.ports = { web: 47_100 };
    });
    await runKernel(fx, ["teardown", first]);
    await runKernel(fx, ["setup"], { cwd: second });
    expect(requiredEntry(fx, second).name).toBe("review");
    expect(requiredEntry(fx, second).entry.ports).toBeUndefined();
    await runKernel(fx, ["setup"], { cwd: first });
    expect(requiredEntry(fx, first).name).toMatch(/^review-[a-f0-9]{8}$/);
  });
});

/** An identity a dev setup created: no preparation ever ran for it. */
async function recordIdentity(fx: KernelFixture, worktree: string, name: string): Promise<void> {
  mkdirSync(registryDir(fx), { recursive: true });
  await updateWorkspaces(fx.repo, registryDir(fx), (registry) => {
    registry.workspaces[name] = {
      worktree,
      createdAt: new Date().toISOString(),
      status: "failed",
      recipe: MANIFEST,
    };
  });
}

function preservationSnapshot(fx: KernelFixture, worktree: string): object {
  return {
    readme: readFileSync(join(worktree, "README.md"), "utf8"),
    dependency: readFileSync(join(worktree, "node_modules/retained"), "utf8"),
    log: readFileSync(join(worktree, ".local-wt/logs/workspace-setup.log"), "utf8"),
    links: [".plans", ".local-wt/workspace-registry"].map((link) =>
      readlinkSync(join(worktree, link)),
    ),
    worktrees: git(fx.repo, "worktree", "list", "--porcelain"),
    refs: git(fx.repo, "show-ref"),
    status: git(worktree, "status", "--porcelain", "--untracked-files=all"),
    exclude: readFileSync(join(fx.repo, ".git/info/exclude"), "utf8"),
  };
}
