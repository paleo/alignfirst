import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceStorage } from "../../src/storage.js";
import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type FixtureOptions,
  fixtureRegistryDir,
  installResourceRecipe,
  resourceEvents,
  readWorkspaces,
  runCli,
  runDev,
} from "./fixture.js";

const TEST_TIMEOUT_MS = 60_000;
const fixtures: ExternalFixture[] = [];
const barriers: string[] = [];

interface ExternalFixture extends FixtureRepo {
  first: string;
  second: string;
}

afterEach(async () => {
  for (const barrier of barriers.splice(0)) writeFileSync(barrier, "release\n");
  const joined: { error: Error | undefined; status: string }[] = [];
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    // Join detached finalizers even when an assertion failed before the scenario's explicit wait.
    try {
      const registry = join(fixtureRegistryDir(fixture.repo), "workspaces.json");
      if (existsSync(registry)) {
        for (const entry of Object.values(readWorkspaces(fixture.repo).workspaces)) {
          const waited = runCli(fixture.repo, ["wait", entry.worktree]);
          joined.push({
            error: waited.error,
            status: entryAt(fixture, entry.worktree).entry.status,
          });
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      const log = join(fixture.repo, "finalize-pids.jsonl");
      if (existsSync(log)) {
        const pids = readFileSync(log, "utf-8").trim().split("\n").map(Number);
        const results = await Promise.allSettled(pids.map(waitForExit));
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
  for (const result of joined) {
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe("pending");
  }
});

describe("externally created same-basename worktrees", () => {
  it(
    "uses independent companion runtimes for detached finalization, cross-target wait and status",
    async () => {
      const fx = externalFixture({ companionRuntime: true, companionRecipe: true });
      const companion = join(fx.root, "companion");
      const file = join(companion, "alignfirst.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.workspace.preSetup = [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Manifest interpolation syntax.
        { name: "companion helper", run: [process.execPath, "${{ configurationDir }}/helper.mjs"] },
      ];
      writeFileSync(file, JSON.stringify(manifest));
      writeFileSync(
        join(companion, "helper.mjs"),
        `import { writeFileSync } from "node:fs"; const ctx = JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT); writeFileSync("helper-context.json", JSON.stringify({ cwd: process.cwd(), ctx }));`,
      );
      const barrier = join(fx.root, "finalizer.release");
      barriers.push(barrier);
      expect(runCli(fx.repo, ["setup", "--path", fx.first]).status).toBe(0);
      const detached = runCli(fx.repo, ["setup", "--path", fx.second, "--detached"], {
        E2E_FINALIZE_BARRIER: barrier,
      });
      expect(detached.status, detached.stderr).toBe(0);
      await waitForFile(`${barrier}.entered`);
      const owner = Number(readFileSync(`${barrier}.owner`, "utf8"));
      expect(entryAt(fx, fx.second).entry.preparationOwner?.pid).toBe(owner);
      const firstRuntime = resolveWorkspaceStorage(
        { in: "companion", mainWorktree: fx.repo, companionDir: companion },
        fx.first,
      ).runtimeDir;
      const secondRuntime = resolveWorkspaceStorage(
        { in: "companion", mainWorktree: fx.repo, companionDir: companion },
        fx.second,
      ).runtimeDir;
      expect(firstRuntime).not.toBe(secondRuntime);
      expect(detached.stdout).toContain(join(secondRuntime, "logs/workspace-setup.log"));
      const status = runCli(fx.repo, ["status", fx.second, "--json"]);
      expect(JSON.parse(status.stdout).workspace).toMatchObject({
        runtimeDir: secondRuntime,
        runtimeState: "active",
        preparation: "pending",
      });
      const refused = runCli(fx.repo, ["__finalize"], undefined, fx.second);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("ownership lost");
      expect(entryAt(fx, fx.second).entry.preparationOwner?.pid).toBe(owner);
      const helper = JSON.parse(readFileSync(join(fx.second, "helper-context.json"), "utf8"));
      expect(helper).toMatchObject({
        cwd: fx.second,
        ctx: { configurationDir: companion, companionDir: companion, runtimeDir: secondRuntime },
      });
      writeFileSync(barrier, "release");
      const waited = runCli(fx.repo, ["wait", fx.second, "--verbose"]);
      expect(waited.status, waited.stderr).toBe(0);
      expect(entryAt(fx, fx.second).entry.preparationOwner).toBeUndefined();
      for (const target of [fx.first, fx.second])
        expect(existsSync(join(target, ".local-wt"))).toBe(false);
      for (const runtime of [firstRuntime, secondRuntime])
        expect(readFileSync(join(runtime, "logs/workspace-setup.log"), "utf8")).toContain("READY:");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tears down through the external target's current recipe and re-adopts without Git deletion",
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup", "--full"], undefined, second).status).toBe(0);
      const target = entryAt(fixture, second);
      installResourceRecipe(repo, "main-version");
      installResourceRecipe(second, "external-version");
      mkdirSync(join(fixture.root, "resources"));
      writeFileSync(join(fixture.root, "resources", target.name), "external resource");
      writeFileSync(join(second, "workspace.local"), "hand-edit\nworktree=linked\n");
      mkdirSync(join(second, "node_modules"));
      writeFileSync(join(second, "node_modules", "retained"), "dependency");
      const before = git(second, ["status", "--porcelain"]);
      expect(runCli(repo, ["teardown", target.name, "--json"]).status).toBe(0);
      expect(resourceEvents(repo)).toMatchObject([
        {
          action: "purge",
          version: "external-version",
          recipeVersion: "external-version",
          cwd: second,
          ctx: {
            name: target.name,
            currentWorktree: second,
            branch: "external-two",
            phase: "purge",
          },
        },
      ]);
      expect(existsSync(join(fixture.root, "resources", target.name))).toBe(false);
      expect(git(second, ["status", "--porcelain"])).toBe(before);
      expect(git(second, ["branch", "--show-current"]).trim()).toBe("external-two");
      expect(readFileSync(join(second, "node_modules", "retained"), "utf8")).toBe("dependency");
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      expect(runCli(repo, ["setup", "--full"], undefined, second).status).toBe(0);
      expect(entryAt(fixture, second).name).toMatch(/^same-[a-f0-9]{8}$/);
      expect(readFileSync(join(second, "workspace.local"), "utf8")).toBe(
        "hand-edit\nworktree=linked\n",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "adopts both paths, seeds and links across parents, and finalizes with registered identities",
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      writeFileSync(join(repo, "workspace.local"), "customized-main\n");
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      expect(runCli(second, ["setup"]).status).toBe(0);
      const one = entryAt(fixture, first);
      const two = entryAt(fixture, second);
      expect(one.name).toBe("same");
      expect(two.name).toMatch(/^same-[a-f0-9]{8}$/);
      expect(one.entry.status).toBe("ready");
      expect(two.entry.status).toBe("ready");
      for (const [worktree, name, branch] of [
        [first, one.name, "external-one"],
        [second, two.name, "external-two"],
      ]) {
        expect(finalizeContext(worktree)).toEqual({
          name,
          currentWorktree: worktree,
          mainWorktree: repo,
          isMainWorktree: false,
          branch,
        });
        expect(readFileSync(join(worktree, "workspace.local"), "utf-8")).toBe(
          "customized-main\nworktree=linked\n",
        );
        expect(realpathSync(join(worktree, ".shared"))).toBe(join(repo, ".shared"));
        expect(realpathSync(join(worktree, ".local-wt", "workspace-registry"))).toBe(
          join(repo, ".local-wt", "workspace-registry"),
        );
      }
      const list = runCli(repo, ["list"]);
      expect(list.status).toBe(0);
      expect(list.stdout).toContain(one.name);
      expect(list.stdout).toContain(two.name);
      expect(list.stdout).toContain(first);
      expect(list.stdout).toContain(second);
      expect(runCli(repo, ["status", one.name]).status).toBe(0);
      expect(runCli(repo, ["status", two.name]).status).toBe(0);
      expect(runCli(repo, ["status", join(fixture.root, "unknown", "same")]).status).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses pending suffixed setup and joins detached success without touching its competitor",
    async () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const barrier = join(fixture.root, "finalize.release");
      barriers.push(barrier);
      const detached = runCli(
        repo,
        ["setup", "--detached"],
        { E2E_FINALIZE_BARRIER: barrier },
        second,
      );
      expect(detached.status).toBe(0);
      expect(detached.stdout).toContain("Setup continuing in background");
      await waitForFile(`${barrier}.entered`);
      const target = entryAt(fixture, second);
      expect(target.entry.status).toBe("pending");
      const refused = runCli(repo, ["setup"], undefined, second);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`already in progress for workspace ${target.name}`);
      writeFileSync(barrier, "release\n");
      expect(runCli(repo, ["wait", target.name]).status).toBe(0);
      expect(entryAt(fixture, second).entry.status).toBe("ready");
      expect(finalizeContext(second).name).toBe(target.name);
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips ready finalize unless forced and keeps the suffixed force run isolated",
    async () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const { name } = entryAt(fixture, second);
      writeFileSync(join(second, "finalized.txt"), "unchanged\n");
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(0);
      expect(readFileSync(join(second, "finalized.txt"), "utf-8")).toBe("unchanged\n");

      const barrier = join(fixture.root, "finalize.release");
      barriers.push(barrier);
      const forced = runCli(
        repo,
        ["setup", "--force", "--detached"],
        { E2E_FINALIZE_BARRIER: barrier },
        second,
      );
      expect(forced.status).toBe(0);
      await waitForFile(`${barrier}.entered`);
      expect(entryAt(fixture, second)).toMatchObject({ name, entry: { status: "pending" } });
      writeFileSync(barrier, "release\n");
      expect(runCli(repo, ["wait", name]).status).toBe(0);
      expect(readFileSync(join(second, "finalized.txt"), "utf-8")).toBe("finalized\n");
      expect(finalizeContext(second).name).toBe(name);
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records suffixed finalize and pre-finalize failures and retries the same identity",
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const failed = runCli(repo, ["setup", "--detached"], { E2E_FINALIZE_FAIL: "1" }, second);
      expect(failed.status).toBe(0);
      const name = entryAt(fixture, second).name;
      const wait = runCli(repo, ["wait", name]);
      expect(wait.status).toBe(1);
      expect(wait.stderr).toContain("finalize step-one");
      expect(entryAt(fixture, second).entry.status).toBe("failed");
      expect(runCli(repo, ["status", name]).stdout).toContain("Failure: finalize step-one");
      expect(runCli(repo, ["status", "same"]).stdout).not.toContain("Failure:");
      const seedFailure = runCli(repo, ["setup"], { E2E_SEED_FAIL: "1" }, second);
      expect(seedFailure.status).toBe(1);
      expect(entryAt(fixture, second).entry.status).toBe("failed");
      expect(entryAt(fixture, second).entry.failure?.message).toContain(
        "workspaceFilePatch.required.local",
      );
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(0);
      expect(entryAt(fixture, second).name).toBe(name);
      expect(entryAt(fixture, second).entry.failure).toBeUndefined();
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps --full dev failures separate, retries ready setup, and resolves nested invocation",
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup", "--full"], undefined, first).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const failed = runCli(repo, ["setup", "--full"], { E2E_DEV_SETUP_FAIL: "1" }, second);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("Workspace ready; dev setup failed: devSetup infrastructure");
      const { name, entry } = entryAt(fixture, second);
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure?.message).toContain("devSetup infrastructure");
      expect(entry.devSetupAt).toBeUndefined();
      const originalPorts = Object.values(original.ports ?? {});
      const failedPorts = Object.values(entry.ports ?? {});
      expect(originalPorts).toHaveLength(2);
      expect(failedPorts).toHaveLength(2);
      expect(failedPorts.filter((port) => originalPorts.includes(port))).toEqual([]);
      mkdirSync(join(second, "nested", "inside"), { recursive: true });
      const nested = join(second, "nested", "inside");
      expect(runCli(repo, ["status"], undefined, nested).stdout).toContain("Dev setup failed:");
      expect(runCli(repo, ["wait"], undefined, nested).status).toBe(1);
      expect(runCli(repo, ["setup", "--full"], undefined, nested).status).toBe(0);
      expect(entryAt(fixture, second).name).toBe(name);
      expect(entryAt(fixture, second).entry.devSetupFailure).toBeUndefined();
      expect(entryAt(fixture, second).entry.devSetupAt).toBeDefined();
      expect(runDev(second, ["setup"]).status).toBe(0);
      expect(readFileSync(join(second, "setup-runs.log"), "utf-8")).toBe("force=false\n");
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function externalFixture(options: FixtureOptions = {}): ExternalFixture {
  const fixture = createFixtureRepo({ fallbackSeeding: true, sharedDirs: [".shared"], ...options });
  const first = join(fixture.root, "managed", "one", "same");
  const second = join(fixture.root, "external", "nested", "two", "same");
  mkdirSync(join(fixture.root, "managed", "one"), { recursive: true });
  mkdirSync(join(fixture.root, "external", "nested", "two"), { recursive: true });
  const external = { ...fixture, first, second };
  fixtures.push(external);
  for (const [path, branch] of [
    [first, "external-one"],
    [second, "external-two"],
  ]) {
    execFileSync("git", ["worktree", "add", "-b", branch, path], {
      cwd: fixture.repo,
      stdio: "pipe",
    });
  }
  return external;
}

function entryAt(fixture: FixtureRepo, path: string): { name: string; entry: WorkspaceEntry } {
  const found = Object.entries(readWorkspaces(fixture.repo).workspaces).find(
    ([, entry]) => entry.worktree === path,
  );
  if (!found) throw new Error(`No registered workspace for ${path}`);
  return { name: found[0], entry: found[1] };
}

function finalizeContext(worktree: string): Record<string, string | boolean> {
  return JSON.parse(readFileSync(join(worktree, "finalize-context.json"), "utf-8"));
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Fixture process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
