import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import { isProcessAlive } from "../src/process-control.js";
import { readWorkspaces } from "../src/workspaces.js";
import {
  addWorktree,
  createKernelFixture,
  devEntries,
  devEntry,
  entryAt,
  failPurges,
  git,
  type KernelFixture,
  MANIFEST_RECIPE as MANIFEST,
  registryDir,
  removeKernelFixtures,
  requiredEntry,
  runKernel,
  runtimeDirOf,
  sleeper,
  useCompanionRuntime,
  workspaceConfig,
  writeDevEntries,
} from "./kernel-fixture.js";

afterEach(removeKernelFixtures);

describe("remove", () => {
  it.each(["locked", "unregistered"])(
    "force refuses a %s target before resource purge",
    async (kind) => {
      const fx = createKernelFixture();
      const linked = addWorktree(fx, "managed/review", "review");
      await runKernel(fx, ["setup"], { cwd: linked });
      const target = requiredEntry(fx, linked);
      if (kind === "locked") git(fx.repo, "worktree", "lock", linked);
      else {
        git(fx.repo, "worktree", "remove", "--force", linked);
        mkdirSync(linked);
      }
      await expect(runKernel(fx, ["remove", linked, "--force"])).rejects.toThrow(WorkspaceError);
      expect(requiredEntry(fx, linked)).toEqual(target);
      expect(fx.purges).toEqual([]);
      expect(existsSync(linked)).toBe(true);
    },
  );

  it("preserves purge-created files hidden by Git config unless explicitly forced", async () => {
    const fx = createKernelFixture();
    fx.config = workspaceConfig(fx.purges, {
      purgeInfrastructure: (ctx) => {
        fx.purges.push(ctx);
        writeFileSync(join(ctx.worktree, "valuable.txt"), "preserve after purge\n");
      },
    });
    const linked = addWorktree(fx, "managed/review", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    git(fx.repo, "config", "status.showUntrackedFiles", "no");
    const worktrees = git(fx.repo, "worktree", "list", "--porcelain");
    const refs = git(fx.repo, "show-ref");
    await expect(runKernel(fx, ["remove", linked])).rejects.toThrow();
    expect(readFileSync(join(linked, "valuable.txt"), "utf8")).toBe("preserve after purge\n");
    expect(git(fx.repo, "worktree", "list", "--porcelain")).toBe(worktrees);
    expect(git(fx.repo, "show-ref")).toBe(refs);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(existsSync(join(linked, ".local-wt/logs/workspace-setup.log"))).toBe(true);
    await runKernel(fx, ["remove", linked, "--force"]);
    expect(existsSync(linked)).toBe(false);
    expect(git(fx.repo, "branch", "--list", "review")).toContain("review");
    expect(fx.purges).toHaveLength(1);
  });

  it("keeps failed cleanup and Git deletion retryable without purging a cleaned generation again", async () => {
    const fx = createKernelFixture();
    useCompanionRuntime(fx);
    let failure: "purge" | "lock" | undefined = "purge";
    fx.config.purgeInfrastructure = (ctx) => {
      fx.purges.push(ctx);
      if (failure === "purge") throw new Error("purge failed");
      if (failure === "lock") git(fx.repo, "worktree", "lock", ctx.worktree);
    };
    const linked = addWorktree(fx, "outside/review", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    const runtime = runtimeDirOf(fx, linked);
    await expect(runKernel(fx, ["remove", linked])).rejects.toThrow("purge failed");
    expect(requiredEntry(fx, linked).entry.cleanupPending).toBe(true);
    expect(existsSync(runtime)).toBe(true);
    failure = "lock";
    await expect(runKernel(fx, ["remove", linked])).rejects.toThrow();
    expect(existsSync(linked)).toBe(true);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(runtimeOwners(fx)).toMatchObject([{ state: "deletionPending" }]);
    await expect(runKernel(fx, ["setup", "--path", linked])).rejects.toThrow();
    failure = undefined;
    git(fx.repo, "worktree", "unlock", linked);
    await runKernel(fx, ["remove", linked]);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(runtime)).toBe(false);
    expect(runtimeOwners(fx)).toEqual([]);
    expect(fx.purges).toHaveLength(2);
  });
});

describe("prune", () => {
  it("retains companion runtime through teardown and prunes the runtime-only orphan without another purge", async () => {
    const fx = createKernelFixture();
    const companion = useCompanionRuntime(fx);
    const linked = addWorktree(fx, "outside/review", "review");
    const sibling = addWorktree(fx, "sibling/review", "sibling");
    await runKernel(fx, ["setup"], { cwd: linked });
    await runKernel(fx, ["setup"], { cwd: sibling });
    const runtime = runtimeDirOf(fx, linked);
    expect(existsSync(join(linked, ".local-wt"))).toBe(false);
    await runKernel(fx, ["teardown", linked]);
    await runKernel(fx, ["teardown", linked]);
    expect(fx.purges).toHaveLength(1);
    expect(existsSync(join(runtime, "logs/workspace-setup.log"))).toBe(true);
    expect(runtimeOwners(fx)).toContainEqual(
      expect.objectContaining({ worktree: linked, state: "retained" }),
    );
    git(fx.repo, "worktree", "remove", linked);
    await runKernel(fx, ["prune"]);
    expect(fx.purges).toHaveLength(1);
    expect(existsSync(runtime)).toBe(false);
    for (const path of [runtimeDirOf(fx, sibling), registryDir(fx), companion])
      expect(existsSync(path)).toBe(true);
  });

  it("prunes an orphan through main's selection, retaining identity until purge succeeds", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "orphan/review", "review");
    const sibling = addWorktree(fx, "sibling/review", "sibling");
    const versions: string[] = [];
    fx.config.recipe = MANIFEST;
    fx.configs.set(
      linked,
      workspaceConfig(fx.purges, {
        recipe: MANIFEST,
        purgeInfrastructure: () => void versions.push("branch"),
      }),
    );
    await runKernel(fx, ["setup"], { cwd: linked });
    await runKernel(fx, ["setup"], { cwd: sibling });
    const target = requiredEntry(fx, linked);
    const other = requiredEntry(fx, sibling);
    failPurges(fx, 1);
    const pid = sleeper();
    writeDevEntries(fx, [devEntry(target.name, linked, pid)]);
    rmSync(linked, { recursive: true, force: true });
    await runKernel(fx, ["list"]);
    expect(requiredEntry(fx, linked)).toEqual(target);
    await expect(runKernel(fx, ["prune"])).rejects.toThrow("purge failed");
    expect(isProcessAlive(pid)).toBe(false);
    expect(requiredEntry(fx, linked)).toEqual({
      ...target,
      entry: { ...target.entry, cleanupPending: true },
    });
    expect(requiredEntry(fx, sibling)).toEqual(other);
    expect(devEntries(fx)).toMatchObject([{ cleanupPending: true }]);
    expect(git(fx.repo, "worktree", "list", "--porcelain")).toContain(linked);
    await runKernel(fx, ["prune"]);
    expect(devEntries(fx)).toEqual([]);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(requiredEntry(fx, sibling)).toEqual(other);
    expect(git(fx.repo, "worktree", "list", "--porcelain")).not.toContain(linked);
    expect(versions).toEqual([]);
    expect(fx.purges.map((ctx) => [ctx.name, ctx.worktree, ctx.mainWorktree])).toEqual([
      [target.name, linked, fx.repo],
      [target.name, linked, fx.repo],
    ]);
  });

  it("passes a suffixed orphan name to purge", async () => {
    const fx = createKernelFixture();
    fx.config.recipe = MANIFEST;
    const first = addWorktree(fx, "one/review", "one");
    const second = addWorktree(fx, "two/review", "two");
    await runKernel(fx, ["setup"], { cwd: first });
    await runKernel(fx, ["setup"], { cwd: second });
    const { name } = requiredEntry(fx, second);
    expect(name).toMatch(/^review-[a-f0-9]{8}$/);
    rmSync(second, { recursive: true, force: true });
    await runKernel(fx, ["prune"]);
    expect(fx.purges.map((ctx) => ctx.name)).toEqual([name]);
    expect(entryAt(fx, first)).toBeDefined();
  });

  it("purges no invented project resources for a defaults-only orphan", async () => {
    const fx = createKernelFixture();
    const linked = addWorktree(fx, "orphan/default", "default");
    await runKernel(fx, ["setup"], { cwd: linked });
    rmSync(linked, { recursive: true, force: true });
    await runKernel(fx, ["prune"]);
    expect(entryAt(fx, linked)).toBeUndefined();
    expect(fx.purges).toEqual([]);
  });

  it("refuses a manifest-backed orphan when main has no purge recipe", async () => {
    const fx = createKernelFixture();
    fx.config.recipe = MANIFEST;
    const linked = addWorktree(fx, "orphan/review", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    const target = requiredEntry(fx, linked);
    rmSync(linked, { recursive: true, force: true });
    fx.config.purgeInfrastructure = undefined;
    await expect(runKernel(fx, ["prune"])).rejects.toThrow();
    expect(requiredEntry(fx, linked)).toEqual(target);
  });

  it("rechecks the captured orphan path on the fresh locked deletion read", async () => {
    const fx = createKernelFixture();
    fx.config.recipe = MANIFEST;
    fx.config.purgeInfrastructure = (ctx) => {
      fx.purges.push(ctx);
      mkdirSync(ctx.worktree, { recursive: true });
    };
    const linked = addWorktree(fx, "outside/review", "review");
    await runKernel(fx, ["setup"], { cwd: linked });
    const before = requiredEntry(fx, linked);
    rmSync(linked, { recursive: true, force: true });
    await expect(runKernel(fx, ["prune"])).rejects.toThrow();
    expect(requiredEntry(fx, linked)).toEqual({
      ...before,
      entry: { ...before.entry, cleanupPending: true },
    });
    expect(fx.purges.map((ctx) => ctx.name)).toEqual([before.name]);
  });
});

function runtimeOwners(fx: KernelFixture) {
  return Object.values(readWorkspaces(fx.repo, registryDir(fx)).runtimeOwners ?? {});
}
