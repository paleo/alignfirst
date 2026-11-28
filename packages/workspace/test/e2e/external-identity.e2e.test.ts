import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceStorage } from "../../src/storage.js";
import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  cleanupFixture,
  type FixtureRepo,
  type FixtureOptions,
  PORT_BLOCKS,
  readWorkspaces,
  runCli,
} from "./fixture.js";

const TEST_TIMEOUT_MS = 60_000;
const fixtures: FixtureRepo[] = [];
const barriers: string[] = [];

interface ExternalFixture extends FixtureRepo {
  first: string;
  second: string;
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const barrier of barriers.splice(0)) {
    try {
      writeFileSync(barrier, "release\n");
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fixture of fixtures.splice(0)) {
    try {
      await cleanupFixture(fixture);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "External fixture cleanup failed");
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
      for (const target of [fx.first, fx.second])
        expect(entryAt(fx, target).entry.status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips ready finalize unless forced, refuses a pending suffixed setup and joins it in isolation",
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
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(1);
      writeFileSync(barrier, "release\n");
      expect(runCli(repo, ["wait", name]).status).toBe(0);
      expect(entryAt(fixture, second).entry.status).toBe("ready");
      expect(readFileSync(join(second, "finalized.txt"), "utf-8")).toBe("finalized\n");
      expect(finalizeContext(second).name).toBe(name);
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );
});

function externalFixture(options: Partial<FixtureOptions> = {}): ExternalFixture {
  const fixture = createFixtureRepo(
    {
      portBlock: PORT_BLOCKS.externalIdentity,
      fallbackSeeding: true,
      sharedDirs: [".shared"],
      ...options,
    },
    (fx) => fixtures.push(fx),
  );
  const first = join(fixture.root, "managed", "one", "same");
  const second = join(fixture.root, "external", "nested", "two", "same");
  mkdirSync(join(fixture.root, "managed", "one"), { recursive: true });
  mkdirSync(join(fixture.root, "external", "nested", "two"), { recursive: true });
  const external = Object.assign(fixture, { first, second });
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
