import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  cleanupFixture,
  cliExecutable,
  DEV_PORTS,
  type FixtureOptions,
  type FixtureRepo,
  fixtureRegistryDir,
  readWorkspaces,
  runCli,
  runDev,
  writeWorkspaces,
} from "./fixture.js";

// Each scenario spawns the CLI plus a detached finalize child — give them room.
const TEST_TIMEOUT_MS = 60_000;

const fixtures: FixtureRepo[] = [];
const barriers: string[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const barrier of barriers.splice(0)) {
    try {
      writeFileSync(barrier, "release\n");
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
  if (failures.length > 0) throw new AggregateError(failures, "Setup fixture cleanup failed");
});

describe("workspace setup (e2e)", () => {
  it(
    "loads every preparation phase from the target branch and keeps noisy JSON output pure",
    () => {
      const { repo } = fixture();
      const manifestPath = join(repo, "alignfirst.json");
      const caller = readFileSync(manifestPath, "utf8");
      const target = JSON.parse(caller);
      target.workspace.preSetup = [
        { name: "target preflight", run: "echo noisy-pre; printf target > pre-target.txt" },
      ];
      target.workspace.gitignoredFiles = [
        { path: "target.local", source: { kind: "content", content: "target branch content" } },
      ];
      target.workspace.finalize = [
        {
          name: "track finalizer",
          run: [cliExecutable, "scripts/lifecycle.mjs", "trackFinalizer"],
        },
        {
          name: "target finalize",
          run: "echo noisy-finalize; printf target > finalized-target.txt",
        },
      ];
      target.workspace.summary = { command: { run: "echo noisy-summary" } };
      writeFileSync(manifestPath, JSON.stringify(target));
      execFileSync("git", ["add", "alignfirst.json"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=E2E",
          "-c",
          "user.email=e2e@example.com",
          "commit",
          "-m",
          "target recipe",
        ],
        { cwd: repo, stdio: "pipe" },
      );
      execFileSync("git", ["branch", "target-recipe"], { cwd: repo });
      writeFileSync(manifestPath, caller);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=E2E",
          "-c",
          "user.email=e2e@example.com",
          "commit",
          "-am",
          "caller recipe",
        ],
        { cwd: repo, stdio: "pipe" },
      );
      const result = runCli(repo, ["setup", "-c", "selected", "--from", "target-recipe", "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout).workspace;
      expect(record).toMatchObject({
        preparation: "ready",
        recipe: "manifest",
        branch: "selected",
      });
      expect(result.stderr).toContain("noisy-pre");
      expect(result.stderr).toContain("noisy-summary");
      expect(readFileSync(join(record.path, "pre-target.txt"), "utf8")).toBe("target");
      expect(readFileSync(join(record.path, "target.local"), "utf8")).toBe("target branch content");
      expect(readFileSync(join(record.path, "finalized-target.txt"), "utf8")).toBe("target");
      expect(existsSync(join(record.path, "finalized.txt"))).toBe(false);
      const failed = runCli(repo, ["setup", "-c", "json-failure", "--json"], {
        E2E_FINALIZE_FAIL: "1",
      });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "blocking setup waits for finalization and marks the workspace ready",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-x"]);
      expect(result.status).toBe(0);
      expect(existsSync(join(repo, "..", "fixrepo-feat-x", "finalized.txt"))).toBe(true);
      expect(entryFor(repo, "fixrepo-feat-x").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "detached setup returns before READY, then `wait` finalizes",
    async () => {
      const fx = fixture();
      const { repo } = fx;
      const barrier = join(fx.root, "finalizer.release");
      barriers.push(barrier);
      const detached = runCli(fx, ["setup", "-c", "feat-y", "-d"], {
        E2E_FINALIZE_BARRIER: barrier,
      });
      expect(detached.status).toBe(0);
      await waitForFile(`${barrier}.entered`);
      expect(entryFor(repo, "fixrepo-feat-y").status).toBe("pending");
      expect(existsSync(join(repo, "..", "fixrepo-feat-y", "finalized.txt"))).toBe(false);
      writeFileSync(barrier, "release\n");

      const waited = runCli(repo, ["wait", "fixrepo-feat-y"]);
      expect(waited.status).toBe(0);
      expect(existsSync(join(repo, "..", "fixrepo-feat-y", "finalized.txt"))).toBe(true);
      expect(entryFor(repo, "fixrepo-feat-y").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "failing finalize exits 1, preserves command output and marks the workspace failed",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-z"], { E2E_FINALIZE_FAIL: "1" });
      expect(result.status).toBe(1);
      expect(setupLog(repo, "fixrepo-feat-z")).toContain("e2e boom");
      expect(entryFor(repo, "fixrepo-feat-z").status).toBe("failed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "seeds from a fallback on main and a customized main file on linked setup",
    () => {
      const { repo } = fixture({ fallbackSeeding: true });

      const mainSetup = runCli(repo, ["setup"]);
      expect(mainSetup.status).toBe(0);
      expect(readFileSync(join(repo, "workspace.local"), "utf-8")).toBe(
        "committed-template\nworktree=main\n",
      );

      writeFileSync(join(repo, "workspace.local"), "customized-main\n");
      const linkedSetup = runCli(repo, ["setup", "-c", "feat-fallback"]);
      expect(linkedSetup.status).toBe(0);
      expect(
        readFileSync(join(repo, "..", "fixrepo-feat-fallback", "workspace.local"), "utf-8"),
      ).toBe("customized-main\nworktree=linked\n");
      expect(readFileSync(join(repo, "workspace.local"), "utf-8")).toBe("customized-main\n");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "re-applies the patch to an existing seeded file without --force",
    () => {
      const { repo } = fixture({ fallbackSeeding: true });
      expect(runCli(repo, ["setup"]).status).toBe(0);

      writeFileSync(join(repo, "workspace.local"), "edited-by-hand\n");
      const rerun = runCli(repo, ["setup"]);
      expect(rerun.status).toBe(0);
      expect(readFileSync(join(repo, "workspace.local"), "utf-8")).toBe(
        "edited-by-hand\nworktree=main\n",
      );

      const unchanged = runCli(repo, ["setup"]);
      expect(unchanged.status).toBe(0);
      expect(readFileSync(join(repo, "workspace.local"), "utf-8")).toBe(
        "edited-by-hand\nworktree=main\n",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps earlier file writes and the ready state when a later patch fails",
    () => {
      const { repo } = fixture({ fallbackSeeding: true });
      expect(runCli(repo, ["setup"]).status).toBe(0);

      writeFileSync(join(repo, "workspace.local"), "edited-by-hand\n");
      writeFileSync(join(repo, "required.local"), "preserve-on-failure\n");
      const rerun = runCli(repo, ["setup"], { E2E_SEED_FAIL: "1" });
      expect(rerun.status).toBe(1);
      expect(rerun.stderr).toContain("missing.template");
      expect(readFileSync(join(repo, "workspace.local"), "utf8")).toBe(
        "edited-by-hand\nworktree=main\n",
      );
      expect(readFileSync(join(repo, "required.local"), "utf8")).toBe("preserve-on-failure\n");
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
      expect(entryFor(repo, "fixrepo").preparationOwner).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a workspace config that still declares `ports`",
    () => {
      const { repo } = fixture({ oldConfig: true });
      const result = runCli(repo, ["setup"]);
      expect(result.status).toBe(1);
      expect(existsSync(registryFile(repo))).toBe(false);
      expect(existsSync(join(repo, "finalized.txt"))).toBe(false);

      const path = join(repo, "alignfirst.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      delete manifest.ports;
      writeFileSync(path, JSON.stringify(manifest));
      const valid = runCli(repo, ["setup"]);
      expect(valid.status, valid.stderr).toBe(0);
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("portless workspace (e2e)", () => {
  it(
    "sets up and removes a workspace with no ports and no dev-server script",
    () => {
      const { repo } = fixture({ portless: true });
      const setup = runCli(repo, ["setup", "-c", "feat-portless"]);
      expect(setup.status).toBe(0);

      const entry = entryFor(repo, "fixrepo-feat-portless");
      expect(entry.status).toBe("ready");
      expect(entry.ports).toBeUndefined();

      // `--force`: the finalize step leaves an untracked `finalized.txt` behind.
      const removed = runCli(repo, ["remove", "fixrepo-feat-portless", "--force"]);
      expect(removed.status).toBe(0);
      expect(existsSync(join(repo, "..", "fixrepo-feat-portless"))).toBe(false);
      expect(readWorkspaces(repo).workspaces["fixrepo-feat-portless"]).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses `setup --full` without a dev-server script, before registration",
    () => {
      const { repo } = fixture({ portless: true });
      const result = runCli(repo, ["setup", "--full"]);
      expect(result.status).toBe(1);
      expect(existsSync(registryFile(repo))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("dev setup (e2e)", () => {
  it(
    "allocates distinct ports to two workspaces, writes the run file, and runs setup once",
    () => {
      const { repo } = fixture();
      expect(runCli(repo, ["setup", "-c", "feat-a"]).status).toBe(0);
      const linked = sibling(repo, "fixrepo-feat-a");
      // `workspace setup` allocates no port and writes no port-bearing file.
      expect(existsSync(join(linked, "ports.env"))).toBe(false);
      expect(entryFor(repo, "fixrepo-feat-a").ports).toBeUndefined();

      const mainSetup = runDev(repo, ["setup"]);
      expect(mainSetup.status).toBe(0);
      const linkedSetup = runDev(linked, ["setup"]);
      expect(linkedSetup.status).toBe(0);

      const main = entryFor(repo, "fixrepo");
      const feat = entryFor(repo, "fixrepo-feat-a");
      expect(main.main).toBe(true);
      const all = [...Object.values(main.ports ?? {}), ...Object.values(feat.ports ?? {})];
      expect(all).toHaveLength(4);
      expect(new Set(all).size).toBe(4);
      for (const port of all) {
        expect(port).toBeGreaterThanOrEqual(DEV_PORTS.first);
        expect(port).toBeLessThanOrEqual(DEV_PORTS.last);
        expect(port).not.toBe(DEV_PORTS.excluded);
      }
      expect(readFileSync(join(linked, "ports.env"), "utf-8")).toBe(portsEnv(feat));
      expect(setupRuns(linked)).toEqual(["force=false"]);
      expect(feat.devSetupAt).toBeDefined();

      const again = runDev(linked, ["setup"]);
      expect(again.status).toBe(0);
      expect(entryFor(repo, "fixrepo-feat-a").ports).toEqual(feat.ports);
      expect(setupRuns(linked)).toEqual(["force=false"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reruns setup with --force, and moves the stored ports with --reset-ports only",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      expect(runDev(repo, ["setup", "--force"]).status).toBe(0);
      expect(setupRuns(repo)).toEqual(["force=false", "force=true"]);

      const registry = readWorkspaces(repo);
      registry.workspaces.fixrepo.ports = { web: 47108, api: 47109 };
      writeWorkspaces(repo, registry);
      expect(runDev(repo, ["setup"]).status).toBe(0);
      expect(entryFor(repo, "fixrepo").ports).toEqual({ web: 47108, api: 47109 });
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(
        portsEnv(entryFor(repo, "fixrepo")),
      );
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe("web=localhost:47108\n");

      const reset = runDev(repo, ["setup", "--reset-ports"]);
      expect(reset.status).toBe(0);
      const ports = entryFor(repo, "fixrepo").ports ?? {};
      expect(ports.web).toBeLessThan(47108);
      expect(ports.api).not.toBe(DEV_PORTS.excluded);
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(
        portsEnv(entryFor(repo, "fixrepo")),
      );
      expect(setupRuns(repo)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a hand-edited run file at a start, and reverts it at an explicit dev setup",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const edited = portsEnv(entryFor(repo, "fixrepo")).replace(/^WEB_PORT=.*$/m, "WEB_PORT=1");
      writeFileSync(join(repo, "ports.env"), edited);

      const started = runDev(repo, ["up"]);
      expect(started.status).toBe(0);
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(edited);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const synced = runDev(repo, ["setup"]);
      expect(synced.status).toBe(0);
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(
        portsEnv(entryFor(repo, "fixrepo")),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rewrites the run files at a start after the ports moved",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const before = entryFor(repo, "fixrepo").ports ?? {};
      const registry = readWorkspaces(repo);
      registry.workspaces.fixrepo.ports = { web: 47108, api: before.api };
      writeWorkspaces(repo, registry);

      const started = runDev(repo, ["up"]);
      expect(started.status).toBe(0);
      expect(runDev(repo, ["down"]).status).toBe(0);
      const entry = entryFor(repo, "fixrepo");
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(portsEnv(entry));
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe("web=localhost:47108\n");
      expect(entry.runFilesWrittenWith).toEqual({ ports: entry.ports, inputs: {} });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rewrites the run files at a start after a run-file input changed",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const web = entryFor(repo, "fixrepo").ports?.web;

      const remote = runDev(repo, ["up"], { E2E_HOST: "example.test" });
      expect(remote.status).toBe(0);
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe(`web=example.test:${web}\n`);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const local = runDev(repo, ["up"]);
      expect(local.status).toBe(0);
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe(`web=localhost:${web}\n`);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const again = runDev(repo, ["up"]);
      expect(again.status).toBe(0);
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe(`web=localhost:${web}\n`);
      expect(runDev(repo, ["down"]).status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "recreates a deleted run file from its source",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      rmSync(join(repo, "ports.env"));
      expect(runDev(repo, ["setup"]).status).toBe(0);
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(
        portsEnv(entryFor(repo, "fixrepo")),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a linked worktree without a registry entry",
    () => {
      const { repo } = fixture();
      const bare = sibling(repo, "fixrepo-bare");
      execFileSync("git", ["worktree", "add", "-b", "bare", bare], { cwd: repo, stdio: "pipe" });
      const result = runDev(bare, ["setup"]);
      expect(result.status).toBe(1);
      expect(existsSync(registryFile(repo))).toBe(false);
      expect(existsSync(join(bare, "ports.env"))).toBe(false);
      expect(setupRuns(bare)).toEqual([]);

      expect(runCli(bare, ["setup"]).status).toBe(0);
      const registered = runDev(bare, ["setup"]);
      expect(registered.status, registered.stderr).toBe(0);
      expect(setupRuns(bare)).toEqual(["force=false"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finalizes the main worktree in a `workspace setup` after a first `dev setup`",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      expect(entryFor(repo, "fixrepo").neverFinalized).toBe(true);
      expect(runCli(repo, ["setup"]).status).toBe(0);
      expect(existsSync(join(repo, "finalized.txt"))).toBe(true);
      const entry = entryFor(repo, "fixrepo");
      expect(entry.status).toBe("ready");
      expect(entry.neverFinalized).toBeUndefined();
      expect(entry.ports).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("workspace setup --full (e2e)", () => {
  it(
    "reaches ready with the dev setup done",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-full", "--full"]);
      expect(result.status).toBe(0);

      const entry = entryFor(repo, "fixrepo-feat-full");
      expect(entry.status).toBe("ready");
      expect(entry.devSetupAt).toBeDefined();
      expect(entry.devSetupFailure).toBeUndefined();
      const linked = sibling(repo, "fixrepo-feat-full");
      expect(readFileSync(join(linked, "ports.env"), "utf-8")).toBe(portsEnv(entry));
      expect(setupRuns(linked)).toEqual(["force=false"]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["E2E_DEV_SETUP_FAIL", "E2E_DEV_EXIT"])(
    "leaves the workspace ready with a retryable dev failure after %s",
    (failure) => {
      const { repo } = fixture();
      const failing = { [failure]: "1" };
      const result = runCli(repo, ["setup", "-c", "feat-fail", "--full"], failing);
      expect(result.status).toBe(1);
      const entry = entryFor(repo, "fixrepo-feat-fail");
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure).toBeDefined();
      expect(entry.devSetupAt).toBeUndefined();

      const waited = runCli(repo, ["wait", "fixrepo-feat-fail"]);
      expect(waited.status).toBe(1);

      const linked = sibling(repo, "fixrepo-feat-fail");
      expect(runDev(linked, ["setup"]).status).toBe(0);
      const retried = entryFor(repo, "fixrepo-feat-fail");
      expect(retried.devSetupFailure).toBeUndefined();
      expect(retried.devSetupAt).toBeDefined();
      expect(runCli(repo, ["wait", "fixrepo-feat-fail"]).status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "forgets the dev failure of an earlier setup in a standalone wait",
    () => {
      const { repo } = fixture();
      expect(runCli(repo, ["setup", "--full"], { E2E_DEV_SETUP_FAIL: "1" }).status).toBe(1);
      expect(runCli(repo, ["setup", "--force", "-d"]).status).toBe(0);
      expect(runCli(repo, ["wait"]).status).toBe(0);
      expect(entryFor(repo, "fixrepo").devSetupFailure).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the dev step from the calling process on an already finalized workspace",
    () => {
      const { repo } = fixture();
      expect(runCli(repo, ["setup"]).status).toBe(0);
      expect(existsSync(join(repo, "ports.env"))).toBe(false);

      const result = runCli(repo, ["setup", "--full"]);
      expect(result.status).toBe(0);
      expect(entryFor(repo, "fixrepo").devSetupAt).toBeDefined();
      expect(existsSync(join(repo, "ports.env"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("workspace remove (e2e)", () => {
  it(
    "retains the workspace when target-owned stop fails after killing recorded processes",
    () => {
      const fx = fixture();
      const { repo } = fx;
      expect(runCli(repo, ["setup", "-c", "feat-rm"]).status).toBe(0);
      const linked = sibling(repo, "fixrepo-feat-rm");
      const pid = startOrphanableSleeper();
      fx.devActivityAttempted = true;
      try {
        writeFileSync(
          join(repo, ".local-wt", "workspace-registry", "dev-servers.json"),
          JSON.stringify({
            version: 1,
            servers: [
              {
                name: "fixrepo-feat-rm",
                worktree: linked,
                pids: { app: pid },
                startedAt: new Date().toISOString(),
              },
            ],
          }),
        );

        const removed = runCli(repo, ["remove", "fixrepo-feat-rm", "--force"], {
          E2E_CALLBACK_RECORD: "1",
          E2E_CALLBACK_STOP_FAIL: "1",
        });
        expect(removed.status).toBe(1);
        expect(isAlive(pid)).toBe(false);
        const devServers = readFileSync(
          join(repo, ".local-wt", "workspace-registry", "dev-servers.json"),
          "utf-8",
        );
        expect(JSON.parse(devServers).servers).toHaveLength(1);
        expect(existsSync(linked)).toBe(true);
        expect(entryFor(repo, "fixrepo-feat-rm").worktree).toBe(linked);
      } finally {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("list and status (e2e)", () => {
  it(
    "report allocated ports and an empty map for a workspace without ports",
    () => {
      const { repo } = fixture();
      expect(runCli(repo, ["setup", "-c", "feat-l"]).status).toBe(0);
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const mainPorts = entryFor(repo, "fixrepo").ports ?? {};

      const list = runCli(repo, ["list", "--json"]);
      expect(list.status, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout).workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "fixrepo", ports: mainPorts }),
          expect.objectContaining({ name: "fixrepo-feat-l", ports: {} }),
        ]),
      );

      const status = runCli(repo, ["status", "--json"]);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).workspace.ports).toEqual(mainPorts);
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(options?: FixtureOptions): FixtureRepo {
  return createFixtureRepo(options, (fx) => fixtures.push(fx));
}

function entryFor(repo: string, name: string): WorkspaceEntry {
  const entry = readWorkspaces(repo).workspaces[name];
  if (!entry) throw new Error(`No workspace registered under "${name}"`);
  return entry;
}

function sibling(repo: string, worktreeDir: string): string {
  return join(repo, "..", worktreeDir);
}

/** The run file the fixture's dev-server writes for the entry's ports. */
function portsEnv(entry: WorkspaceEntry): string {
  return `# ports\nWEB_PORT=${entry.ports?.web}\nAPI_PORT=${entry.ports?.api}\n`;
}

function setupRuns(worktree: string): string[] {
  const path = join(worktree, "setup-runs.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n");
}

/**
 * Starts a sleeping process whose parent shell exits at once: init reaps it once killed, while this
 * test process is blocked in `spawnSync`.
 */
function startOrphanableSleeper(): number {
  const sleeper = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const out = execFileSync("sh", ["-c", `${sleeper} >/dev/null 2>&1 & echo $!`], {
    encoding: "utf-8",
  });
  return Number(out.trim());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registryFile(repo: string): string {
  return join(fixtureRegistryDir(repo), "workspaces.json");
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setupLog(repo: string, worktreeDir: string): string {
  return readFileSync(
    join(repo, "..", worktreeDir, ".local-wt", "logs", "workspace-setup.log"),
    "utf-8",
  );
}
