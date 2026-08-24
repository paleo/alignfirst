import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  type FixtureOptions,
  type FixtureRepo,
  packageRoot,
  readWorkspaces,
  runCli,
} from "./fixture.js";

// Each scenario spawns the CLI plus a detached finalize child — give them room.
const TEST_TIMEOUT_MS = 60_000;

const createdRoots: string[] = [];

beforeAll(() => {
  buildIfStale();
}, 120_000);

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace setup (e2e)", () => {
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
      expect(output).toContain("FAILED");
      expect(output).toContain("e2e boom");
      expect(entryFor(repo, "fixrepo-feat-z").status).toBe("failed");
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
    "allocates the port block of the workspace's index",
    () => {
      const { repo } = fixture();
      runCli(repo, ["setup", "-c", "feat-p"]);
      expect(entryFor(repo, "fixrepo-feat-p").portIndex).toBe(1);
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
      expect(entry.portIndex).toBeUndefined();

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
});

describe("setup --profile (e2e)", () => {
  const PROFILE_FIXTURE: FixtureOptions = { profiles: true, fallbackSeeding: true };

  it(
    "applies the profile on the main worktree after seeding",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      const result = runCli(repo, ["setup", "--profile", "claw"]);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output).toContain("Applied profile claw.");
      expect(output).toContain("… ready");
      expect(profileMarker(repo)).toEqual({
        ports: { web: 8100 },
        seeded: "committed-template\nworktree=main\n",
      });
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reapplies the profile on a configured main without --force",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      expect(runCli(repo, ["setup", "--profile", "claw"]).status).toBe(0);
      const first = profileMarker(repo);
      rmSync(join(repo, "profile-applied.txt"));

      const rerun = runCli(repo, ["setup", "--profile", "claw"]);
      expect(rerun.status).toBe(0);
      expect(profileMarker(repo)).toEqual(first);
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses --profile from a linked worktree, before any write",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      expect(runCli(repo, ["setup"]).status).toBe(0);
      expect(runCli(repo, ["setup", "-c", "feat-linked"]).status).toBe(0);
      const linked = join(repo, "..", "fixrepo-feat-linked");

      const result = runCli(linked, ["setup", "--profile", "claw"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("main worktree");
      expect(existsSync(join(linked, "profile-applied.txt"))).toBe(false);
      expect(entryFor(repo, "fixrepo-feat-linked").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "marks the workspace failed when the profile throws, then a plain retry succeeds",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      const failed = runCli(repo, ["setup", "--profile", "claw"], { E2E_PROFILE_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('Profile "claw": e2e profile boom');
      expect(entryFor(repo, "fixrepo").status).toBe("failed");
      expect(existsSync(join(repo, "profile-applied.txt"))).toBe(false);

      const retry = runCli(repo, ["setup"]);
      expect(retry.status).toBe(0);
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a configured main ready when the profile throws",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      expect(runCli(repo, ["setup"]).status).toBe(0);

      const failed = runCli(repo, ["setup", "--profile", "claw"], { E2E_PROFILE_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('Profile "claw": e2e profile boom');
      expect(entryFor(repo, "fixrepo").status).toBe("ready");
      expect(existsSync(join(repo, "profile-applied.txt"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an unknown profile name, listing the declared ones, before registration",
    () => {
      const { repo } = fixture(PROFILE_FIXTURE);
      const result = runCli(repo, ["setup", "--profile", "nope"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown profile "nope". Declared profiles: claw.');
      expect(existsSync(registryFile(repo))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses --profile when the project declares no setupProfiles, before registration",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "--profile", "claw"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("declares no setup profile");
      expect(existsSync(registryFile(repo))).toBe(false);
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

interface ProfileMarker {
  ports: Record<string, number>;
  seeded: string;
}

function profileMarker(repo: string): ProfileMarker {
  return JSON.parse(readFileSync(join(repo, "profile-applied.txt"), "utf-8")) as ProfileMarker;
}

function registryFile(repo: string): string {
  return join(repo, ".wt", "workspace-registry", "workspaces.json");
}

function setupLog(repo: string, worktreeDir: string): string {
  return readFileSync(join(repo, "..", worktreeDir, ".wt", "logs", "workspace-setup.log"), "utf-8");
}

// Rebuild `dist/` only when it is missing or older than the newest `src/` file, so a second `vitest`
// run in a row skips the rebuild.
function buildIfStale(): void {
  const distIndex = join(packageRoot, "dist", "index.js");
  if (existsSync(distIndex) && statSync(distIndex).mtimeMs >= newestSrcMtime()) {
    console.log("[e2e] dist is up to date; skipping build.");
    return;
  }
  console.log("[e2e] building @paleo/workspace…");
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
