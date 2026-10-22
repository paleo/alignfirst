import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/workspaces.js";
import { createFixtureRepo, type FixtureRepo, readWorkspaces, runCli, runDev } from "./fixture.js";

const TEST_TIMEOUT_MS = 60_000;
const fixtures: ExternalFixture[] = [];

interface ExternalFixture extends FixtureRepo {
  first: string;
  second: string;
}

afterEach(() => {
  const joined: { error: Error | undefined; status: string }[] = [];
  for (const fixture of fixtures.splice(0)) {
    // Join detached finalizers even when an assertion failed before the scenario's explicit wait.
    try {
      const registry = join(fixture.repo, ".wt", "workspace-registry", "workspaces.json");
      if (!existsSync(registry)) continue;
      for (const entry of Object.values(readWorkspaces(fixture.repo).workspaces)) {
        const waited = runCli(fixture.repo, ["wait", entry.worktree]);
        joined.push({
          error: waited.error,
          status: entryAt(fixture, entry.worktree).entry.status,
        });
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  for (const result of joined) {
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe("pending");
  }
});

describe("externally created same-basename worktrees", () => {
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
        expect(realpathSync(join(worktree, ".wt", "workspace-registry"))).toBe(
          join(repo, ".wt", "workspace-registry"),
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
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const detached = runCli(
        repo,
        ["setup", "--detached"],
        { E2E_FINALIZE_DELAY_MS: "1800" },
        second,
      );
      expect(detached.status).toBe(0);
      expect(detached.stdout).toContain("Setup continuing in background");
      const target = entryAt(fixture, second);
      expect(target.entry.status).toBe("pending");
      const refused = runCli(repo, ["setup"], undefined, second);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`already in progress for workspace ${target.name}`);
      expect(runCli(repo, ["wait", target.name]).status).toBe(0);
      expect(entryAt(fixture, second).entry.status).toBe("ready");
      expect(finalizeContext(second).name).toBe(target.name);
      expect(entryAt(fixture, first).entry).toEqual(original);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips ready finalize unless forced and keeps the suffixed force run isolated",
    () => {
      const fixture = externalFixture();
      const { repo, first, second } = fixture;
      expect(runCli(repo, ["setup"], undefined, first).status).toBe(0);
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(0);
      const original = entryAt(fixture, first).entry;
      const { name } = entryAt(fixture, second);
      writeFileSync(join(second, "finalized.txt"), "unchanged\n");
      expect(runCli(repo, ["setup"], undefined, second).status).toBe(0);
      expect(readFileSync(join(second, "finalized.txt"), "utf-8")).toBe("unchanged\n");

      const forced = runCli(
        repo,
        ["setup", "--force", "--detached"],
        { E2E_FINALIZE_DELAY_MS: "1000" },
        second,
      );
      expect(forced.status).toBe(0);
      expect(entryAt(fixture, second)).toMatchObject({ name, entry: { status: "pending" } });
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
      expect(wait.stderr).toContain("e2e boom");
      expect(entryAt(fixture, second).entry.status).toBe("failed");
      expect(runCli(repo, ["status", name]).stdout).toContain("Failure: e2e boom");
      expect(runCli(repo, ["status", "same"]).stdout).not.toContain("Failure:");
      const seedFailure = runCli(repo, ["setup"], { E2E_SEED_FAIL: "1" }, second);
      expect(seedFailure.status).toBe(1);
      expect(entryAt(fixture, second).entry.status).toBe("failed");
      expect(entryAt(fixture, second).entry.failure?.message).toContain("missing.template");
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
      expect(failed.stderr).toContain("Workspace ready; dev setup failed: e2e dev boom");
      const { name, entry } = entryAt(fixture, second);
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure?.message).toContain("e2e dev boom");
      expect(entry.devSetupAt).toBeUndefined();
      expect(
        Object.values(entry.ports ?? {}).every(
          (port) => !Object.values(original.ports ?? {}).includes(port),
        ),
      ).toBe(true);
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

function externalFixture(): ExternalFixture {
  const fixture = createFixtureRepo({ fallbackSeeding: true, sharedDirs: [".shared"] });
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
