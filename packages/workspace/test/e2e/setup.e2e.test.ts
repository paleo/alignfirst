import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  DEV_PORTS,
  type FixtureOptions,
  type FixtureRepo,
  packageRoot,
  readWorkspaces,
  runCli,
  runDev,
  writeWorkspaces,
} from "./fixture.js";

// Each scenario spawns the CLI plus a detached finalize child — give them room.
const TEST_TIMEOUT_MS = 60_000;

const createdRoots: string[] = [];

beforeAll(() => {
  buildIfStale();
}, 120_000);

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    const repo = join(root, "fixrepo");
    if (existsSync(registryFile(repo))) {
      for (const entry of Object.values(readWorkspaces(repo).workspaces)) {
        if (entry.status === "pending") runCli(repo, ["wait", entry.worktree]);
      }
    }
    const log = join(repo, "finalize-pids.jsonl");
    if (existsSync(log)) {
      for (const pid of readFileSync(log, "utf-8").trim().split("\n").map(Number)) {
        const deadline = Date.now() + 10_000;
        while (isAlive(pid)) {
          if (Date.now() > deadline) throw new Error(`Finalizer ${pid} did not exit`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    runDev(repo, ["down", "--all"]);
    rmSync(root, { recursive: true, force: true });
  }
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
          name: "target finalize",
          run: "echo noisy-finalize; printf target > finalized-target.txt",
        },
      ];
      target.workspace.summary = { command: { run: "echo noisy-summary" } };
      writeFileSync(manifestPath, JSON.stringify(target));
      execFileSync("git", ["add", "alignfirst.json"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "target recipe"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["branch", "target-recipe"], { cwd: repo });
      writeFileSync(manifestPath, caller);
      execFileSync("git", ["commit", "-am", "caller recipe"], { cwd: repo, stdio: "pipe" });
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
      expect(failed.stderr).toContain("Setup failed:");
    },
    TEST_TIMEOUT_MS,
  );

  it("renders direct workspace/dev commands despite unrelated npm scripts and lockfiles", () => {
    const { repo } = fixture();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { workspace: "exit 99", dev: "exit 99" } }),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}");
    const guide = runCli(repo, ["--guide"]);
    expect(guide.status, guide.stderr).toBe(0);
    expect(guide.stdout).toContain("alignfirst workspace setup");
    expect(guide.stdout).not.toContain("npm run");
    for (const result of [runCli(repo, ["unknown"]), runDev(repo, ["unknown"])]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("alignfirst");
      expect(result.stderr).toContain("--help");
    }
  });

  it(
    "blocking setup reaches READY and prints no background message",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-x"]);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output).toContain("… ready");
      expect(output).not.toContain("Setup continuing in background.");
      expect(existsSync(join(repo, "..", "fixrepo-feat-x", "finalized.txt"))).toBe(true);
      expect(entryFor(repo, "fixrepo-feat-x").status).toBe("ready");
      const log = setupLog(repo, "fixrepo-feat-x");
      expect(log).toContain("PROGRESS: step-one");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "detached setup returns before READY, then `wait` finalizes",
    () => {
      const { repo } = fixture();
      const detached = runCli(repo, ["setup", "-c", "feat-y", "-d"]);
      const detachedOut = detached.stdout + detached.stderr;

      expect(detached.status).toBe(0);
      expect(detachedOut).toContain("Setup continuing in background.");
      expect(detachedOut).toContain("Join it with");

      const waited = runCli(repo, ["wait", "fixrepo-feat-y"]);
      expect(waited.status).toBe(0);
      expect(existsSync(join(repo, "..", "fixrepo-feat-y", "finalized.txt"))).toBe(true);
      expect(entryFor(repo, "fixrepo-feat-y").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "failing finalize exits 1 with the FAILED reason",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-z"], { E2E_FINALIZE_FAIL: "1" });
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(1);
      expect(output).toContain("Setup failed:");
      expect(setupLog(repo, "fixrepo-feat-z")).toContain("e2e boom");
      expect(output).toContain("finalize step-one");
      expect(entryFor(repo, "fixrepo-feat-z").status).toBe("failed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a failing finalize retried from inside the worktree omits the foreign-script hint",
    () => {
      const { repo } = fixture();
      runCli(repo, ["setup", "-c", "feat-r"], { E2E_FINALIZE_FAIL: "1" });
      const retry = runCli(join(repo, "..", "fixrepo-feat-r"), ["setup"], {
        E2E_FINALIZE_FAIL: "1",
      });
      const output = retry.stdout + retry.stderr;

      expect(retry.status).toBe(1);
      expect(output).toContain("finalize step-one");
      expect(setupLog(repo, "fixrepo-feat-r")).toContain("e2e boom");
      expect(output).not.toContain("ran the workspace scripts of another worktree");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "detached --enter prints the cd hint immediately on non-TTY",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-g", "-d", "--enter"]);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output).toContain("Now run: cd");
      expect(output).toContain("Setup continuing in background.");
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
      expect(rerun.stdout).toContain("Updated workspace.local.");
      expect(setupLog(repo, "fixrepo")).toContain("Updated workspace.local.");
      expect(readFileSync(join(repo, "workspace.local"), "utf-8")).toBe(
        "edited-by-hand\nworktree=main\n",
      );

      const unchanged = runCli(repo, ["setup"]);
      expect(unchanged.status).toBe(0);
      expect(unchanged.stdout).not.toContain("Updated");
      expect(setupLog(repo, "fixrepo")).toContain("Skipped workspace.local (already up to date).");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a file already rewritten when a later entry fails",
    () => {
      const { repo } = fixture({ fallbackSeeding: true });
      expect(runCli(repo, ["setup"]).status).toBe(0);

      writeFileSync(join(repo, "workspace.local"), "edited-by-hand\n");
      const rerun = runCli(repo, ["setup"], { E2E_SEED_FAIL: "1" });
      expect(rerun.status).toBe(1);
      expect(rerun.stdout).toContain("Updated workspace.local.");
      const log = setupLog(repo, "fixrepo");
      expect(log).toContain("Updated workspace.local.");
      expect(log).toContain("FAILED");
      expect(log.indexOf("Updated workspace.local.")).toBeLessThan(log.lastIndexOf("FAILED"));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a workspace config that still declares `ports`",
    () => {
      const { repo } = fixture({ oldConfig: true });
      const result = runCli(repo, ["setup"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('"/ports" must NOT have additional properties');
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
      expect(setup.stdout + setup.stderr).toContain("… ready");
      expect(setup.status).toBe(0);

      const entry = entryFor(repo, "fixrepo-feat-portless");
      expect(entry.status).toBe("ready");
      expect(entry.ports).toBeUndefined();

      // Without a dev-server script there is no dev-server block to report.
      const status = runCli(repo, ["status", "fixrepo-feat-portless"]);
      expect(status.status).toBe(0);
      expect(status.stdout).not.toContain("Dev-server");

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
      expect(result.stderr).toContain("requires declared dev services");
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
      expect(mainSetup.stdout).toContain("Ports: web=");
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
      expect(again.stdout).not.toContain("Ports:");
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
      expect(reset.stdout).toContain("Ports: web=");
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
      expect(started.stderr).not.toContain("Warning");
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(edited);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const synced = runDev(repo, ["setup"]);
      expect(synced.stdout).toContain("Updated ports.env.");
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(
        portsEnv(entryFor(repo, "fixrepo")),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rewrites the run files at a start after the ports moved, with a warning",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const before = entryFor(repo, "fixrepo").ports ?? {};
      const registry = readWorkspaces(repo);
      registry.workspaces.fixrepo.ports = { web: 47108, api: before.api };
      writeWorkspaces(repo, registry);

      const started = runDev(repo, ["up"]);
      expect(started.status).toBe(0);
      expect(started.stderr).toContain(
        `Warning: the ports moved (web ${before.web} → 47108). Updated ports.env, ports.txt.`,
      );
      expect(runDev(repo, ["down"]).status).toBe(0);
      const entry = entryFor(repo, "fixrepo");
      expect(readFileSync(join(repo, "ports.env"), "utf-8")).toBe(portsEnv(entry));
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe("web=localhost:47108\n");
      expect(entry.runFilesWrittenWith).toEqual({ ports: entry.ports, inputs: {} });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rewrites the run files at a start after a run-file input changed, with a warning",
    () => {
      const { repo } = fixture();
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const web = entryFor(repo, "fixrepo").ports?.web;

      const remote = runDev(repo, ["up"], { E2E_HOST: "example.test" });
      expect(remote.status).toBe(0);
      expect(remote.stderr).toContain(
        "Warning: the run-file inputs changed (E2E_HOST). Updated ports.txt.",
      );
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe(`web=example.test:${web}\n`);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const local = runDev(repo, ["up"]);
      expect(local.stderr).toContain("Warning: the run-file inputs changed (E2E_HOST).");
      expect(readFileSync(join(repo, "ports.txt"), "utf-8")).toBe(`web=localhost:${web}\n`);
      expect(runDev(repo, ["down"]).status).toBe(0);

      const again = runDev(repo, ["up"]);
      expect(again.stderr).not.toContain("Warning");
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
      expect(result.stderr).toContain("workspace setup");
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
      expect(result.stdout).toContain("… ready");

      const entry = entryFor(repo, "fixrepo-feat-full");
      expect(entry.status).toBe("ready");
      expect(entry.devSetupAt).toBeDefined();
      expect(entry.devSetupFailure).toBeUndefined();
      const linked = sibling(repo, "fixrepo-feat-full");
      expect(readFileSync(join(linked, "ports.env"), "utf-8")).toBe(portsEnv(entry));
      expect(setupRuns(linked)).toEqual(["force=false"]);
      expect(setupLog(repo, "fixrepo-feat-full")).toContain("PROGRESS: Dev setup");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the workspace ready with devSetupFailure when setup fails, and exits 1",
    () => {
      const { repo } = fixture();
      const failing = { E2E_DEV_SETUP_FAIL: "1" };
      const result = runCli(repo, ["setup", "-c", "feat-fail", "--full"], failing);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Workspace ready; dev setup failed: devSetup infrastructure");
      const entry = entryFor(repo, "fixrepo-feat-fail");
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure?.message).toContain("devSetup infrastructure");
      expect(entry.devSetupAt).toBeUndefined();
      expect(setupLog(repo, "fixrepo-feat-fail")).toContain(
        "DEV SETUP FAILED: devSetup infrastructure",
      );

      const waited = runCli(repo, ["wait", "fixrepo-feat-fail"]);
      expect(waited.status).toBe(1);
      expect(waited.stderr).toContain("dev setup failed: devSetup infrastructure");
      const status = runCli(repo, ["status", "fixrepo-feat-fail"]);
      expect(status.stdout).toContain("Dev setup failed: devSetup infrastructure");

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
    "records the failing lifecycle command's exit code",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-exit", "--full"], { E2E_DEV_EXIT: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dev setup failed: devSetup infrastructure: exited with code 3",
      );
      const entry = entryFor(repo, "fixrepo-feat-exit");
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure?.message).toBe("devSetup infrastructure: exited with code 3.");
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
      const { repo } = fixture();
      expect(runCli(repo, ["setup", "-c", "feat-rm"]).status).toBe(0);
      const linked = sibling(repo, "fixrepo-feat-rm");
      const pid = startOrphanableSleeper();
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
        expect(removed.stderr).toContain("stop");
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
    "show the ports, `-` for a workspace without",
    () => {
      const { repo } = fixture();
      expect(runCli(repo, ["setup", "-c", "feat-l"]).status).toBe(0);
      expect(runDev(repo, ["setup"]).status).toBe(0);
      const mainPorts = entryFor(repo, "fixrepo").ports ?? {};

      const list = runCli(repo, ["list"]);
      expect(list.status).toBe(0);
      const [header, ...rows] = list.stdout.trim().split("\n");
      const column = header.split(/\s+/).indexOf("PORTS");
      expect(column).toBeGreaterThan(0);
      const cell = (name: string): string | undefined =>
        rows.find((row) => row.startsWith(`${name} `))?.split(/\s+/)[column];
      expect(cell("fixrepo")).toBe(Object.values(mainPorts).join(","));
      expect(cell("fixrepo-feat-l")).toBe("-");

      const status = runCli(repo, ["status"]);
      expect(status.stdout).toContain(`Ports: web=${mainPorts.web}, api=${mainPorts.api}`);
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(options?: FixtureOptions): FixtureRepo {
  const fx = createFixtureRepo(options);
  createdRoots.push(fx.root);
  return fx;
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
  return join(repo, ".local-wt", "workspace-registry", "workspaces.json");
}

function setupLog(repo: string, worktreeDir: string): string {
  return readFileSync(
    join(repo, "..", worktreeDir, ".local-wt", "logs", "workspace-setup.log"),
    "utf-8",
  );
}

// Rebuild `dist/` only when it is missing or older than the newest `src/` file, so a second `vitest`
// run in a row skips the rebuild.
function buildIfStale(): void {
  const distIndex = join(packageRoot, "dist", "index.js");
  if (existsSync(distIndex) && statSync(distIndex).mtimeMs >= newestSrcMtime()) {
    console.log("[e2e] dist is up to date; skipping build.");
    return;
  }
  console.log("[e2e] building @alignfirst/workspace…");
  execFileSync("npm", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
}

function newestSrcMtime(): number {
  const srcDir = join(packageRoot, "src");
  let newest = 0;
  for (const rel of readdirSync(srcDir, { recursive: true })) {
    const full = join(srcDir, rel.toString());
    const stat = statSync(full);
    if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}
