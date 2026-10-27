import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevServerEntry } from "../../src/dev-servers-registry.js";
import type { PurgeContext } from "../../src/workspace.js";
import type { WorkspaceEntry, WorkspacesRegistry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  type FixtureOptions,
  type FixtureRepo,
  readWorkspaces,
  runCli,
  runDev,
  installResourceRecipe,
  resourceEvents,
} from "./fixture.js";

const TEST_TIMEOUT_MS = 60_000;
const fixtures: FixtureRepo[] = [];
const barriers: string[] = [];
const sleepers: number[] = [];

afterEach(async () => {
  const finalizers: number[] = [];
  for (const barrier of barriers.splice(0)) {
    writeFileSync(barrier, "release\n");
    if (existsSync(`${barrier}.entered`)) {
      finalizers.push(Number(readFileSync(`${barrier}.entered`, "utf-8")));
    }
  }
  const ownedFixtures = fixtures.splice(0);
  const unsettled: string[] = [];
  try {
    for (const fixture of ownedFixtures) {
      if (!existsSync(registryFile(fixture.repo, "workspaces.json"))) continue;
      for (const entry of Object.values(readWorkspaces(fixture.repo).workspaces)) {
        if (entry.status !== "pending") continue;
        const result = runCli(fixture.repo, ["wait", entry.worktree]);
        if (result.error || entryAt(fixture.repo, entry.worktree)?.entry.status === "pending") {
          unsettled.push(entry.worktree);
        }
      }
    }
    for (const fixture of ownedFixtures) {
      const log = join(fixture.repo, "finalize-pids.jsonl");
      if (existsSync(log)) {
        finalizers.push(...readFileSync(log, "utf-8").trim().split("\n").map(Number));
      }
    }
    for (const pid of new Set(finalizers)) await waitForExit(pid);
  } finally {
    for (const pid of sleepers.splice(0)) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      await waitForExit(pid);
    }
    for (const fixture of ownedFixtures) rmSync(fixture.root, { recursive: true, force: true });
  }
  expect(unsettled).toEqual([]);
});

describe("workspace teardown (e2e)", () => {
  it(
    "prunes orphans using main scripts, retaining identity and ports until purge succeeds",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "orphan/review", "review");
      const sibling = addWorktree(fx, "sibling/review", "sibling");
      setup(fx.repo, linked, true);
      setup(fx.repo, sibling, true);
      const target = requiredEntry(fx.repo, linked);
      const other = requiredEntry(fx.repo, sibling);
      installResourceRecipe(linked, "deleted-branch");
      installResourceRecipe(fx.repo, "surviving-main");
      const mainManifestPath = join(fx.repo, "alignfirst.json");
      const mainManifest = JSON.parse(readFileSync(mainManifestPath, "utf8"));
      mainManifest.workspace.purge[0].continueOnError = true;
      mainManifest.workspace.purge.push({
        name: "after-resource",
        run: 'printf attempted > "$ALIGNFIRST_MAIN_WORKTREE/after-purge"',
      });
      writeFileSync(mainManifestPath, JSON.stringify(mainManifest));
      mkdirSync(join(fx.root, "resources"));
      const marker = join(fx.root, "resources", target.name);
      writeFileSync(marker, "branch resource");
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry(target.name, linked, pid)]);
      rmSync(linked, { recursive: true, force: true });
      expect(runCli(fx.repo, ["list", "--json"]).status).toBe(0);
      expect(requiredEntry(fx.repo, linked)).toEqual(target);
      const failed = runCli(fx.repo, ["prune", "--json"], { E2E_RESOURCE_FAIL: "purge" });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(fx.repo, "after-purge"), "utf8")).toBe("attempted");
      expect(isAlive(pid)).toBe(false);
      expect(requiredEntry(fx.repo, linked)).toEqual({
        ...target,
        entry: { ...target.entry, cleanupPending: true },
      });
      expect(requiredEntry(fx.repo, sibling)).toEqual(other);
      expect(devEntries(fx.repo)).toMatchObject([{ cleanupPending: true }]);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).toContain(linked);
      const retry = runCli(fx.repo, ["prune", "--json"]);
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout).pruned).toEqual([{ path: linked, name: target.name }]);
      expect(existsSync(marker)).toBe(false);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(requiredEntry(fx.repo, sibling)).toEqual(other);
      for (const event of resourceEvents(fx.repo)) {
        expect(event).toMatchObject({
          action: "purge",
          version: "surviving-main",
          cwd: fx.repo,
          ctx: { name: target.name, currentWorktree: linked, phase: "purge" },
        });
        expect(event.ctx.branch).toBeUndefined();
        expect(event.ctx.ports).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "purges no invented project resources for a defaults-only orphan",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "orphan/default", "default");
      rmSync(join(linked, "alignfirst.json"));
      setup(fx.repo, linked);
      const target = requiredEntry(fx.repo, linked);
      expect(target.entry.recipe).toEqual({ kind: "defaults" });
      rmSync(linked, { recursive: true, force: true });
      expect(runCli(fx.repo, ["list"]).status).toBe(0);
      expect(runCli(fx.repo, ["prune"]).status).toBe(0);
      expect(entryAt(fx.repo, linked)).toBeUndefined();
      expect(purges(fx.repo)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["manifest", "script"])(
    "refuses a missing orphan %s rather than forgetting registration or reserved ports",
    (missing) => {
      const fx = fixture();
      const linked = addWorktree(fx, "orphan/review", "review");
      setup(fx.repo, linked, true);
      const target = requiredEntry(fx.repo, linked);
      rmSync(linked, { recursive: true, force: true });
      rmSync(join(fx.repo, missing === "manifest" ? "alignfirst.json" : "scripts/lifecycle.mjs"));
      const failed = runCli(fx.repo, ["prune", "--json"]);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain(
        missing === "manifest" ? "manifest recipe is missing" : "purge purge",
      );
      expect(requiredEntry(fx.repo, linked)).toEqual({
        ...target,
        entry: { ...target.entry, ...(missing === "script" ? { cleanupPending: true } : {}) },
      });
      expect(purges(fx.repo)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["locked", "nested", "shared", "unregistered"])(
    "force refuses %s targets before resource purge",
    (kind) => {
      const fx = fixture();
      const linked = addWorktree(fx, "managed/review", "review");
      setup(fx.repo, linked);
      installResourceRecipe(linked, "protected-target");
      const target = requiredEntry(fx.repo, linked);
      if (kind === "locked") git(fx.repo, ["worktree", "lock", linked]);
      if (kind === "nested")
        git(fx.repo, ["worktree", "add", "-b", "nested", join(linked, "nested")]);
      if (kind === "shared") {
        mkdirSync(join(linked, "protected"));
        symlinkSync(join(linked, "protected"), join(fx.repo, ".protected"));
        const path = join(fx.repo, "alignfirst.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.workspace.sharedDirs = [".protected"];
        writeFileSync(path, JSON.stringify(manifest));
      }
      if (kind === "unregistered") {
        git(fx.repo, ["worktree", "remove", "--force", linked]);
        mkdirSync(linked);
      }
      const result = runCli(fx.repo, ["remove", linked, "--force", "--json"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        kind === "locked"
          ? "locked worktree"
          : kind === "nested"
            ? "another registered worktree"
            : kind === "shared"
              ? "protected shared directory"
              : "not an exact registered Git worktree root",
      );
      expect(requiredEntry(fx.repo, linked)).toEqual(target);
      expect(purges(fx.repo)).toEqual([]);
      expect(resourceEvents(fx.repo)).toEqual([]);
      expect(existsSync(linked)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["current", "nested", "absolute", "relative", "name"])(
    "preserves files and Git state with the %s selector, including dirty same-basename targets",
    (selector) => {
      const fx = fixture({ fallbackSeeding: true, sharedDirs: [".shared"] });
      const first = addWorktree(fx, "one/same", "one");
      const second = addWorktree(fx, "two/same", "two");
      setup(fx.repo, first, true);
      setup(fx.repo, second, true);
      const original = entryAt(fx.repo, first);
      const target = requiredEntry(fx.repo, second);
      expect(target.name).toMatch(/^same-[a-f0-9]{8}$/);
      writeFileSync(join(second, "scripts", "ready-server.mjs"), "// dirty tracked file\n");
      writeFileSync(join(second, "untracked.txt"), "untracked content\n");
      mkdirSync(join(second, "node_modules", "fake"), { recursive: true });
      writeFileSync(join(second, "node_modules", "fake", "index.js"), "installed\n");
      writeFileSync(join(second, ".local-wt", "logs", "app.log"), "runtime log\n");
      writeFileSync(join(fx.repo, ".shared", "note"), "shared content\n");
      mkdirSync(join(second, "nested", "inside"), { recursive: true });
      git(second, ["config", "extensions.worktreeConfig", "true"]);
      git(second, ["config", "--worktree", "fixture.local", "preserved"]);
      const before = preservationSnapshot(fx.repo, second);
      const cwd =
        selector === "current"
          ? second
          : selector === "nested"
            ? join(second, "nested", "inside")
            : fx.repo;
      const args =
        selector === "absolute"
          ? [second]
          : selector === "relative"
            ? [relative(fx.repo, second)]
            : selector === "name"
              ? [target.name]
              : [];
      const result = runCli(fx.repo, ["teardown", ...args, "--verbose"], undefined, cwd);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Worktree files and Git registration kept");
      expect(preservationSnapshot(fx.repo, second)).toEqual(before);
      expect(entryAt(fx.repo, second)).toBeUndefined();
      expect(entryAt(fx.repo, first)).toEqual(original);
      expect(purges(fx.repo)).toEqual([
        {
          name: target.name,
          worktree: second,
          mainWorktree: fx.repo,
          verbose: true,
        },
      ]);
      expect(runCli(fx.repo, ["teardown", second]).status).toBe(0);
      expect(purges(fx.repo)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tears down main without dismantling the shared registry or linked workspace",
    () => {
      const fx = fixture({ sharedDirs: [".shared"] });
      const linked = addWorktree(fx, "outside/review", "review");
      setup(fx.repo, fx.repo, true);
      setup(fx.repo, linked, true);
      const original = requiredEntry(fx.repo, linked);
      const pid = startSleeper(fx.repo);
      const linkedDev = devEntry(original.name, linked, pid);
      writeDevEntries(fx.repo, [devEntry("fixrepo", fx.repo), linkedDev]);
      const beforeGit = git(fx.repo, ["worktree", "list", "--porcelain"]);
      expect(runCli(fx.repo, ["remove", "--force"]).status).toBe(1);
      const result = runCli(fx.repo, ["teardown"]);
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(dirname(registryFile(fx.repo, "workspaces.json"))).isDirectory()).toBe(true);
      expect(lstatSync(dirname(registryFile(fx.repo, "workspaces.json"))).isSymbolicLink()).toBe(
        false,
      );
      expect(entryAt(fx.repo, linked)).toEqual(original);
      expect(entryAt(fx.repo, fx.repo)).toBeUndefined();
      expect(realpathSync(join(linked, ".shared"))).toBe(join(fx.repo, ".shared"));
      expect(realpathSync(join(linked, ".local-wt", "workspace-registry"))).toBe(
        dirname(registryFile(fx.repo, "workspaces.json")),
      );
      expect(readFileSync(join(linked, "ports.env"), "utf-8")).toContain("WEB_PORT=");
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).toBe(beforeGit);
      expect(runCli(fx.repo, ["teardown"]).status).toBe(0);
      expect(runCli(fx.repo, ["remove", "--force"]).stderr).toContain("Cannot remove the main");
      expect(purges(fx.repo)).toHaveLength(1);
      expect(devEntries(fx.repo)).toEqual([linkedDev]);
      expect(isAlive(pid)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "deletes by captured path when teardown is the first writer after a genuine main rename",
    () => {
      const fx = fixture();
      setup(fx.repo, fx.repo, true);
      const linked = addWorktree(fx, "linked/renamed", "review");
      setup(fx.repo, linked, true);
      const oldName = requiredEntry(fx.repo, fx.repo).name;
      const other = requiredEntry(fx.repo, linked);
      const renamed = join(fx.root, "renamed");
      renameSync(fx.repo, renamed);
      fx.repo = renamed;
      git(renamed, ["worktree", "repair"]);
      const result = runCli(renamed, ["teardown"]);
      expect(result.status, result.stderr).toBe(0);
      expect(entryAt(renamed, renamed)).toBeUndefined();
      expect(entryAt(renamed, linked)).toEqual(other);
      expect(purges(renamed)).toEqual([
        {
          name: oldName,
          worktree: renamed,
          mainWorktree: renamed,
          verbose: false,
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

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
        expect(refused.stderr).toContain(`still in progress for workspace ${before.name}`);
        expect(refused.stderr).toContain(`wait '${second}'`);
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

  it.each(["ready", "finalizeFailure", "partial"])(
    "purges %s setup with its recorded name; a thrown purge retains registration",
    (state) => {
      const fx = fixture({ fallbackSeeding: true });
      const linked = addWorktree(fx, "managed/review", "review");
      const env: Record<string, string> | undefined =
        state === "finalizeFailure"
          ? { E2E_FINALIZE_FAIL: "1" }
          : state === "partial"
            ? { E2E_SEED_FAIL: "1" }
            : undefined;
      expect(runCli(fx.repo, ["setup"], env, linked).status).toBe(state === "ready" ? 0 : 1);
      const target = requiredEntry(fx.repo, linked);
      writeDevEntries(fx.repo, [devEntry("stale-dev-name", linked)]);
      const failed = runCli(fx.repo, ["teardown", linked], { E2E_PURGE_FAIL: "1" });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("e2e purge boom");
      expect(requiredEntry(fx.repo, linked).name).toBe(target.name);
      expect(devEntries(fx.repo)).toMatchObject([{ cleanupPending: true }]);
      expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
      expect(entryAt(fx.repo, linked)).toBeUndefined();
      expect(purges(fx.repo)).toEqual(
        Array.from({ length: 2 }, () => ({
          name: target.name,
          worktree: linked,
          mainWorktree: fx.repo,
          verbose: false,
        })),
      );
      expect(existsSync(linked)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gates ready workspaces without dev records until purge succeeds, even after force or dev down",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "managed/retry", "retry");
      setup(fx.repo, linked);
      const target = requiredEntry(fx.repo, linked);
      expect(devEntries(fx.repo)).toEqual([]);
      const failed = runCli(fx.repo, ["teardown", linked], { E2E_PURGE_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(requiredEntry(fx.repo, linked).entry).toMatchObject({
        status: "ready",
        cleanupPending: true,
      });
      const forced = runCli(fx.repo, ["setup", "--force"], undefined, linked);
      expect(forced.status).toBe(1);
      expect(forced.stderr).toContain("cleanup is pending");
      writeDevEntries(fx.repo, [{ ...devEntry(target.name, linked), cleanupPending: true }]);
      expect(runDev(linked, ["down"]).status).toBe(0);
      expect(devEntries(fx.repo)).toEqual([]);
      for (const args of [["setup", "--force"], ["up"]]) {
        const blocked = runDev(linked, args);
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain("cleanup is pending");
      }
      expect(existsSync(join(linked, "setup-runs.log"))).toBe(false);
      expect(requiredEntry(fx.repo, linked).entry.cleanupPending).toBe(true);
      expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
      expect(entryAt(fx.repo, linked)).toBeUndefined();
      expect(runCli(fx.repo, ["setup"], undefined, linked).status).toBe(0);
      expect(runDev(linked, ["setup"]).status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([false, true])(
    "retains failed stop work before purge and retries cleanup, stop failure=%s",
    (failStop) => {
      const fx = fixture();
      const linked = addWorktree(fx, "managed/review", "review");
      setup(fx.repo, linked, true);
      const target = requiredEntry(fx.repo, linked);
      writeDevEntries(fx.repo, [devEntry(target.name, linked)]);
      const result = runCli(fx.repo, ["teardown", linked], {
        E2E_CALLBACK_RECORD: "1",
        E2E_CALLBACK_STOP_FAIL: failStop ? "1" : "0",
      });
      expect(result.status, result.stderr).toBe(failStop ? 1 : 0);
      expect(readJsonLines(join(fx.repo, "callback-runs.jsonl"))).toEqual(
        stopEvents(target.name, linked, target.entry.ports ?? {}),
      );
      if (failStop) {
        expect(result.stderr).toContain("e2e callback stop boom");
        expect(devEntries(fx.repo)[0].cleanupPending).toBe(true);
        expect(requiredEntry(fx.repo, linked)).toEqual({
          ...target,
          entry: { ...target.entry, cleanupPending: true },
        });
        expect(purges(fx.repo)).toEqual([]);
        expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
      }
      expect(devEntries(fx.repo)).toEqual([]);
      expect(purges(fx.repo)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["stopFailure", "noServices"])(
    "kills recorded PIDs with %s, including a dev-created identity",
    (mode) => {
      const fx = fixture({ portless: mode === "noServices" });
      const linked = addWorktree(fx, "managed/review", "review");
      if (mode === "stopFailure") setup(fx.repo, linked);
      else recordIdentity(fx.repo, linked, "recorded-infra");
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry("recorded-infra", linked, pid)]);
      const result = runCli(fx.repo, ["teardown", linked], {
        E2E_CALLBACK_RECORD: "1",
        E2E_CALLBACK_STOP_FAIL: "1",
      });
      expect(result.status, result.stderr).toBe(mode === "stopFailure" ? 1 : 0);
      expect(isAlive(pid)).toBe(false);
      if (mode === "stopFailure") {
        expect(result.stderr).toContain("e2e callback stop boom");
        expect(devEntries(fx.repo)[0].cleanupPending).toBe(true);
        expect(purges(fx.repo)).toEqual([]);
        expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
      }
      expect(devEntries(fx.repo)).toEqual([]);
      expect(purges(fx.repo)[0].name).toBe(mode === "noServices" ? "recorded-infra" : "review");
      expect(existsSync(linked)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["noServices", "stopUnregisters", "missingWorktree"])(
    "retains a durable dev-created identity through purge failure: %s",
    (mode) => {
      const fx = fixture({ portless: mode === "noServices" });
      const linked = addWorktree(fx, "outside/review", "review");
      recordIdentity(fx.repo, linked, "recorded-infra");
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry("recorded-infra", linked, pid)]);
      if (mode === "missingWorktree") rmSync(linked, { recursive: true, force: true });
      const failed = runCli(fx.repo, ["teardown", linked], {
        E2E_PURGE_FAIL: "1",
        E2E_CALLBACK_RECORD: "1",
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("e2e purge boom");
      expect(isAlive(pid)).toBe(false);
      expect(devEntries(fx.repo)).toMatchObject([{ cleanupPending: true }]);
      expect(requiredEntry(fx.repo, linked)).toMatchObject({
        name: "recorded-infra",
        entry: { status: "failed" },
      });
      if (mode === "stopUnregisters") {
        expect(readJsonLines(join(fx.repo, "callback-runs.jsonl"))).toEqual(
          stopEvents("recorded-infra", linked, {}),
        );
      }
      const retained = requiredEntry(fx.repo, linked);
      const listed = runCli(fx.repo, ["list"]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(requiredEntry(fx.repo, linked)).toEqual(retained);
      expect(purges(fx.repo)).toHaveLength(1);
      if (mode === "missingWorktree") expect(listed.stdout).toContain("prune");
      const retry = runCli(fx.repo, ["teardown", "recorded-infra"]);
      expect(retry.status, retry.stderr).toBe(0);
      expect(entryAt(fx.repo, linked)).toBeUndefined();
      expect(purges(fx.repo).map((ctx) => ctx.name)).toEqual(["recorded-infra", "recorded-infra"]);
      if (mode !== "missingWorktree") {
        expect(runCli(fx.repo, ["teardown", linked]).status).toBe(0);
        expect(purges(fx.repo)).toHaveLength(2);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["path", "name"])(
    "cleans a durably identified orphan with dead PIDs by its recorded %s without Git pruning",
    (selector) => {
      const fx = fixture({ portless: true });
      const linked = addWorktree(fx, "outside/review", "review");
      recordIdentity(fx.repo, linked, "recorded-dev-only");
      writeDevEntries(fx.repo, [devEntry("recorded-dev-only", linked)]);
      rmSync(linked, { recursive: true, force: true });
      const before = git(fx.repo, ["worktree", "list", "--porcelain"]);
      const result = runCli(fx.repo, [
        "teardown",
        selector === "path" ? linked : "recorded-dev-only",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(purges(fx.repo)).toEqual([
        {
          name: "recorded-dev-only",
          worktree: linked,
          mainWorktree: fx.repo,
          verbose: false,
        },
      ]);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([false, true])(
    "stops every recorded main process with no services=%s",
    (portless) => {
      const fx = fixture({ portless });
      setup(fx.repo, fx.repo);
      const pids = [startSleeper(fx.repo), startSleeper(fx.repo)];
      writeDevEntries(fx.repo, [
        { ...devEntry("fixrepo", fx.repo), main: true, pids: { app: pids[0], worker: pids[1] } },
      ]);
      const result = runCli(fx.repo, ["teardown"]);
      expect(result.status, result.stderr).toBe(0);
      expect(pids.map(isAlive)).toEqual([false, false]);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(entryAt(fx.repo, fx.repo)).toBeUndefined();
      expect(purges(fx.repo).map((ctx) => ctx.name)).toEqual(["fixrepo"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retains a real stop failure even when no PID remains",
    () => {
      const fx = fixture();
      setup(fx.repo, fx.repo);
      writeDevEntries(fx.repo, [devEntry("old", fx.repo)]);
      const result = runCli(fx.repo, ["teardown", "--json"], {
        E2E_CALLBACK_RECORD: "1",
        E2E_CALLBACK_STOP_FAIL: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("e2e callback stop boom");
      expect(devEntries(fx.repo)[0].cleanupPending).toBe(true);
      expect(purges(fx.repo)).toEqual([]);
      expect(runCli(fx.repo, ["teardown"]).status).toBe(0);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(purges(fx.repo)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "accepts only verified unregistered worktrees and never guesses a same-basename identity",
    () => {
      const fx = fixture();
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "two/review", "two");
      expect(runCli(fx.repo, ["teardown"]).status).toBe(0);
      expect(existsSync(registryFile(fx.repo, "workspaces.json"))).toBe(false);
      setup(fx.repo, first);
      const original = requiredEntry(fx.repo, first);
      expect(runCli(fx.repo, ["teardown", second]).status).toBe(0);
      const unrelated = createFixtureRepo();
      fixtures.push(unrelated);
      const plain = join(fx.root, "plain", "review");
      mkdirSync(plain, { recursive: true });
      for (const selector of ["typo", join(fx.root, "missing", "review"), plain, unrelated.repo]) {
        expect(runCli(fx.repo, ["teardown", selector]).status).toBe(1);
        expect(requiredEntry(fx.repo, first)).toEqual(original);
        expect(purges(fx.repo)).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "checks both registries by path before names, and preserves the workspace identity",
    () => {
      const fx = fixture({ portless: true });
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "fixrepo/two/review", "two");
      setup(fx.repo, first);
      recordIdentity(fx.repo, second, "dev-only-identity");
      const original = requiredEntry(fx.repo, first);
      writeDevEntries(fx.repo, [
        devEntry("dev-only-identity", second),
        devEntry("wrong-dev", first),
      ]);
      const result = runCli(fx.repo, ["teardown", "review"], undefined, dirname(second));
      expect(result.status, result.stderr).toBe(0);
      expect(purges(fx.repo)[0].name).toBe("dev-only-identity");
      expect(requiredEntry(fx.repo, first)).toEqual(original);
      expect(devEntries(fx.repo)).toEqual([devEntry("wrong-dev", first)]);
      expect(runCli(fx.repo, ["teardown", "wrong-dev"]).status).toBe(0);
      expect(purges(fx.repo)[1].name).toBe(original.name);
      expect(devEntries(fx.repo)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "tears down registered orphans by exact path or suffixed name without Git pruning",
    () => {
      const fx = fixture();
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "two/review", "two");
      setup(fx.repo, first);
      setup(fx.repo, second);
      const target = requiredEntry(fx.repo, second);
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
      const before = git(fx.repo, ["worktree", "list", "--porcelain"]);
      writeDevEntries(fx.repo, [devEntry(target.name, second)]);
      expect(runCli(fx.repo, ["teardown", target.name]).status).toBe(0);
      expect(runCli(fx.repo, ["teardown", first]).status).toBe(0);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).toBe(before);
      expect(purges(fx.repo).map((ctx) => ctx.name)).toEqual([target.name, "review"]);
      expect(devEntries(fx.repo)).toEqual([]);
      expect(readWorkspaces(fx.repo).workspaces).toEqual({});
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["remove", "prune"])(
    "retains %s orphan cleanup and passes suffixed names to purge",
    (command) => {
      const fx = fixture();
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "two/review", "two");
      setup(fx.repo, first);
      setup(fx.repo, second);
      const name = requiredEntry(fx.repo, second).name;
      rmSync(second, { recursive: true, force: true });
      const result = runCli(fx.repo, command === "remove" ? [command, name] : [command]);
      expect(result.status, result.stderr).toBe(0);
      expect(purges(fx.repo).map((ctx) => ctx.name)).toEqual([name]);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).not.toContain(second);
      expect(entryAt(fx.repo, first)).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "prunes an abandoned pending orphan after its detached finalizer is killed",
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
      process.kill(owner, "SIGKILL");
      await waitForExit(owner);
      process.kill(finalizer, "SIGKILL");
      await waitForExit(finalizer);
      const before = requiredEntry(fx.repo, linked);
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry(before.name, linked, pid)]);
      rmSync(linked, { recursive: true, force: true });
      for (const command of [
        ["teardown", before.name],
        ["remove", before.name],
      ]) {
        expect(runCli(fx.repo, command).stderr).toContain("still in progress");
        expect(isAlive(pid)).toBe(true);
        expect(purges(fx.repo)).toEqual([]);
      }
      const failed = runCli(fx.repo, ["prune"], { E2E_PURGE_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("e2e purge boom");
      expect(requiredEntry(fx.repo, linked)).toEqual({
        ...before,
        entry: { ...before.entry, cleanupPending: true },
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

  it(
    "prune rechecks the captured orphan path on the fresh locked deletion read",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "outside/review", "review");
      setup(fx.repo, linked);
      const before = requiredEntry(fx.repo, linked);
      rmSync(linked, { recursive: true, force: true });
      const result = runCli(fx.repo, ["prune"], { E2E_PURGE_RECREATE_WORKTREE: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(requiredEntry(fx.repo, linked)).toEqual(before);
      expect(purges(fx.repo)[0].name).toBe(before.name);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "list retains every orphan without invoking purge or stopping live PIDs",
    () => {
      const fx = fixture();
      const safe = addWorktree(fx, "one/review", "one");
      const live = addWorktree(fx, "two/review", "two");
      setup(fx.repo, safe);
      setup(fx.repo, live);
      const name = requiredEntry(fx.repo, live).name;
      const pid = startSleeper(fx.repo);
      writeDevEntries(fx.repo, [devEntry("review", safe), devEntry(name, live, pid)]);
      rmSync(safe, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
      const result = runCli(fx.repo, ["list"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(name);
      expect(result.stdout).toContain("prune");
      expect(entryAt(fx.repo, safe)).toBeDefined();
      expect(entryAt(fx.repo, live)).toBeDefined();
      expect(isAlive(pid)).toBe(true);
      expect(purges(fx.repo)).toEqual([]);
      expect(runCli(fx.repo, ["prune"]).status).toBe(0);
      expect(isAlive(pid)).toBe(false);
      expect(purges(fx.repo).map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["review", name]),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases names and ports for another worktree before setup re-adopts and reprovisions",
    () => {
      const fx = fixture();
      const first = addWorktree(fx, "one/review", "one");
      const second = addWorktree(fx, "two/review", "two");
      setup(fx.repo, first, true);
      const original = requiredEntry(fx.repo, first);
      expect(runCli(fx.repo, ["teardown", first]).status).toBe(0);
      setup(fx.repo, second, true);
      expect(requiredEntry(fx.repo, second).name).toBe(original.name);
      expect(requiredEntry(fx.repo, second).entry.ports).toEqual(original.entry.ports);
      writeFileSync(join(first, "finalized.txt"), "must finalize again\n");
      setup(fx.repo, first);
      expect(readFileSync(join(first, "finalized.txt"), "utf-8")).toBe("finalized\n");
      expect(runDev(first, ["setup"]).status).toBe(0);
      expect(requiredEntry(fx.repo, first).name).toMatch(/^review-[a-f0-9]{8}$/);
      expect(requiredEntry(fx.repo, first).entry.ports).not.toEqual(original.entry.ports);
      expect(readFileSync(join(first, "setup-runs.log"), "utf-8")).toBe(
        "force=false\nforce=false\n",
      );
      expect(runCli(fx.repo, ["teardown", first]).status).toBe(0);
      expect(runCli(fx.repo, ["teardown", second]).status).toBe(0);
      setup(fx.repo, first);
      expect(requiredEntry(fx.repo, first).name).toBe("review");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps remove dirty/force checks and retains the branch",
    () => {
      const fx = fixture();
      const linked = addWorktree(fx, "managed/review", "review");
      setup(fx.repo, linked);
      const before = requiredEntry(fx.repo, linked);
      writeFileSync(join(linked, "untracked.txt"), "dirty\n");
      expect(runCli(fx.repo, ["remove", linked]).stderr).toContain("Uncommitted changes");
      expect(requiredEntry(fx.repo, linked)).toEqual(before);
      expect(purges(fx.repo)).toEqual([]);
      expect(runCli(fx.repo, ["remove", linked, "--force"]).status).toBe(0);
      expect(existsSync(linked)).toBe(false);
      expect(git(fx.repo, ["branch", "--list", "review"])).toContain("review");
      expect(purges(fx.repo)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(options?: FixtureOptions): FixtureRepo {
  const fx = createFixtureRepo(options);
  fixtures.push(fx);
  return fx;
}

function addWorktree(fx: FixtureRepo, path: string, branch: string): string {
  const worktree = join(fx.root, path);
  mkdirSync(dirname(worktree), { recursive: true });
  git(fx.repo, ["worktree", "add", "-b", branch, worktree]);
  return worktree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function setup(repo: string, worktree: string, full = false): void {
  const result = runCli(repo, ["setup", ...(full ? ["--full"] : [])], undefined, worktree);
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
  return join(repo, ".local-wt", "workspace-registry", file);
}

function devEntry(name: string, worktree: string, pid?: number): DevServerEntry {
  return {
    name,
    worktree,
    pids: { app: pid ?? 2_147_483_647 },
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function recordIdentity(repo: string, worktree: string, name: string): void {
  const file = registryFile(repo, "workspaces.json");
  const registry: WorkspacesRegistry = existsSync(file) ? readWorkspaces(repo) : { workspaces: {} };
  registry.workspaces[name] = {
    worktree,
    createdAt: new Date().toISOString(),
    status: "failed",
    recipe: { kind: "manifest", file: "alignfirst.json", in: "project" },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      ...registry,
      version: 4,
      storage: { in: "project", mainWorktree: repo, registryDir: dirname(file) },
      runtimeOwners: {},
    }),
  );
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

function stopEvents(name: string, cwd: string, ports: Record<string, number>): object[] {
  return [
    { event: "legacyStop", name, cwd, ports },
    ...["cache", "docker"].map((label) => ({ event: "stop", name, cwd, ports, label })),
  ];
}

function preservationSnapshot(repo: string, worktree: string): object {
  const files = [
    "scripts/ready-server.mjs",
    "untracked.txt",
    "node_modules/fake/index.js",
    "workspace.local",
    "ports.env",
    "ports.txt",
    "setup-runs.log",
    "finalized.txt",
    "finalize-context.json",
    ".local-wt/logs/workspace-setup.log",
    ".local-wt/logs/app.log",
    ".git",
  ];
  return {
    files: Object.fromEntries(
      files.map((file) => [file, readFileSync(join(worktree, file), "utf-8")]),
    ),
    links: [".shared", ".local-wt/workspace-registry"].map((link) => ({
      target: readlinkSync(join(worktree, link)),
      real: realpathSync(join(worktree, link)),
    })),
    shared: readFileSync(join(repo, ".shared", "note"), "utf-8"),
    config: git(worktree, ["config", "--worktree", "--list"]),
    worktrees: git(repo, ["worktree", "list", "--porcelain"]),
    refs: git(repo, ["show-ref"]),
    status: git(worktree, ["status", "--porcelain", "--untracked-files=all"]),
  };
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
  const sleeper = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const pid = Number(
    execFileSync("sh", ["-c", `${sleeper} >/dev/null 2>&1 & echo $!`], {
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
