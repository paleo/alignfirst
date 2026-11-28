import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevServerEntry } from "../../src/dev-servers-registry.js";
import type { PurgeContext } from "../../src/workspace.js";
import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  cleanupFixture,
  type FixtureRepo,
  fixtureRegistryDir,
  PORT_BLOCKS,
  readWorkspaces,
  runCli,
} from "./fixture.js";

const TEST_TIMEOUT_MS = 60_000;
const fixtures: FixtureRepo[] = [];
const barriers: string[] = [];
const sleepers: number[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const barrier of barriers.splice(0)) {
    try {
      writeFileSync(barrier, "release\n");
    } catch (error) {
      failures.push(error);
    }
  }
  for (const pid of sleepers.splice(0)) {
    try {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      await waitForExit(pid);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fx of fixtures.splice(0)) {
    try {
      await cleanupFixture(fx);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Teardown fixture cleanup failed");
});

describe("workspace teardown (e2e)", () => {
  it(
    "refuses pending suffixed setup before stop, purge or deletion and joins its finalizer",
    async () => {
      const fx = fixture();
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "two/review", "two");
      setup(fx.repo, first);
      const barrier = join(fx.root, "finalize.release");
      barriers.push(barrier);
      expect(
        runCli(
          fx.repo,
          ["setup", "--detached"],
          {
            E2E_FINALIZE_BARRIER: barrier,
          },
          second,
        ).status,
      ).toBe(0);
      await waitForFile(`${barrier}.entered`);
      const before = requiredEntry(fx.repo, second);
      const dev = devEntry(before.name, second);
      writeDevEntries(fx.repo, [dev]);
      for (const command of [
        ["teardown", before.name],
        ["remove", second, "--force"],
      ]) {
        const refused = runCli(fx.repo, command, { E2E_CALLBACK_RECORD: "1" });
        expect(refused.status).toBe(1);
        expect(requiredEntry(fx.repo, second)).toEqual(before);
        expect(devEntries(fx.repo)).toEqual([dev]);
        expect(purges(fx.repo)).toEqual([]);
        expect(existsSync(join(fx.repo, "callback-runs.jsonl"))).toBe(false);
      }
      writeFileSync(barrier, "release\n");
      expect(runCli(fx.repo, ["wait", before.name]).status).toBe(0);
      expect(requiredEntry(fx.repo, second).entry.status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills recorded PIDs and retains cleanup when the target stop child fails",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "managed/review", "review");
      setup(fx.repo, linked);
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry("recorded-infra", linked, pid)]);
      const result = runCli(fx.repo, ["teardown", linked], {
        E2E_CALLBACK_RECORD: "1",
        E2E_CALLBACK_STOP_FAIL: "1",
      });
      expect(result.status, result.stderr).toBe(1);
      expect(isAlive(pid)).toBe(false);
      expect(result.stderr).toContain("e2e callback stop boom");
      expect(devEntries(fx.repo)[0].cleanupPending).toBe(true);
      expect(purges(fx.repo)).toEqual([]);
      expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(purges(fx.repo)[0].name).toBe("review");
      expect(existsSync(linked)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "prunes an abandoned pending orphan only after its finalizer exits",
    async () => {
      const fx = fixture();
      const linked = addWorktree(fx, "outside/review", "review");
      const barrier = join(fx.root, "finalize.release");
      barriers.push(barrier);
      expect(
        runCli(fx.repo, ["setup", "--detached"], { E2E_FINALIZE_BARRIER: barrier }, linked).status,
      ).toBe(0);
      await waitForFile(`${barrier}.entered`);
      const finalizer = Number(readFileSync(`${barrier}.entered`, "utf-8"));
      const owner = Number(readFileSync(`${barrier}.owner`, "utf8"));
      const before = requiredEntry(fx.repo, linked);
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry(before.name, linked, pid)]);
      rmSync(linked, { recursive: true, force: true });
      for (const command of [["teardown", before.name], ["remove", before.name], ["prune"]]) {
        expect(runCli(fx.repo, command).status).toBe(1);
        expect(isAlive(pid)).toBe(true);
        expect(purges(fx.repo)).toEqual([]);
      }
      process.kill(owner, "SIGKILL");
      await waitForExit(owner);
      process.kill(finalizer, "SIGKILL");
      await waitForExit(finalizer);
      const failed = runCli(fx.repo, ["prune"], { E2E_PURGE_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("e2e purge boom");
      const { preparationOwner: _owner, ...abandoned } = before.entry;
      expect(requiredEntry(fx.repo, linked)).toEqual({
        ...before,
        entry: { ...abandoned, cleanupPending: true },
      });
      const result = runCli(fx.repo, ["prune"]);
      expect(result.status, result.stderr).toBe(0);
      expect(isAlive(pid)).toBe(false);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(entryAt(fx.repo, linked)).toBeUndefined();
      expect(purges(fx.repo).map((ctx) => ctx.name)).toEqual([before.name, before.name]);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).not.toContain(linked);
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(): FixtureRepo {
  return createFixtureRepo({ portBlock: PORT_BLOCKS.teardown }, (fx) => fixtures.push(fx));
}

function addWorktree(fx: FixtureRepo, path: string, branch: string): string {
  const worktree = join(fx.root, path);
  mkdirSync(dirname(worktree), { recursive: true });
  git(fx.repo, ["worktree", "add", "-b", branch, worktree]);
  return worktree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function setup(repo: string, worktree: string): void {
  const result = runCli(repo, ["setup"], undefined, worktree);
  expect(result.status, result.stderr).toBe(0);
}

function requiredEntry(repo: string, worktree: string): { name: string; entry: WorkspaceEntry } {
  const found = entryAt(repo, worktree);
  if (!found) throw new Error(`No workspace at ${worktree}`);
  return found;
}

function entryAt(
  repo: string,
  worktree: string,
): { name: string; entry: WorkspaceEntry } | undefined {
  const found = Object.entries(readWorkspaces(repo).workspaces).find(
    ([, entry]) => entry.worktree === worktree,
  );
  if (found) return { name: found[0], entry: found[1] };
}

function registryFile(repo: string, file: string): string {
  return join(fixtureRegistryDir(repo), file);
}

function devEntry(name: string, worktree: string, pid?: number): DevServerEntry {
  return {
    name,
    worktree,
    pids: { app: pid ?? 2_147_483_647 },
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function writeDevEntries(repo: string, servers: DevServerEntry[]): void {
  writeFileSync(registryFile(repo, "dev-servers.json"), JSON.stringify({ version: 1, servers }));
}

function devEntries(repo: string): DevServerEntry[] {
  const file = registryFile(repo, "dev-servers.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8")).servers;
}

function purges(repo: string): PurgeContext[] {
  const file = join(repo, "purge-runs.jsonl");
  if (!existsSync(file)) return [];
  return readJsonLines(file);
}

function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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

function startSleeper(cwd: string): number {
  const pid = Number(
    execFileSync("sh", ["-c", "sleep 600 >/dev/null 2>&1 & echo $!"], {
      cwd,
      encoding: "utf-8",
    }).trim(),
  );
  sleepers.push(pid);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
