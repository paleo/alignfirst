import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceManifest } from "../../src/workspace-config-types.js";
import type { WorkspaceEntry } from "../../src/workspaces.js";
import {
  createFixtureRepo,
  cleanupFixture,
  cliExecutable,
  type FixtureRepo,
  PORT_BLOCKS,
  readWorkspaces,
  runCli,
  runDev,
} from "./fixture.js";

// Each scenario spawns the CLI plus a detached finalize child — give them room.
const TEST_TIMEOUT_MS = 60_000;

const fixtures: FixtureRepo[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
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
    "leaves the workspace ready with a retryable dev failure after the dev setup child exits",
    () => {
      const { repo } = fixture();
      const result = runCli(repo, ["setup", "-c", "feat-fail", "--full"], { E2E_DEV_EXIT: "1" });
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
    "prepares and runs a project without Node through shell recipes, isolated per workspace",
    () => {
      const fx = fixture();
      const { repo } = fx;
      writeFileSync(
        join(repo, "alignfirst.json"),
        JSON.stringify({ schemaVersion: 1, ...shellRecipe() }),
      );
      writeFileSync(
        join(repo, ".gitignore"),
        "/.plans\n/.local-wt/\napp.env\nidentity.txt\napi.pid\n",
      );
      commit(repo, "shell recipe");
      const main = runCli(fx, ["setup", "--full", "--json"]);
      expect(main.status, main.stderr).toBe(0);
      const child = runCli(fx, ["setup", "-c", "shell-child", "--full", "--json"]);
      expect(child.status, child.stderr).toBe(0);
      const linked = JSON.parse(child.stdout).workspace.path;
      const ports = [repo, linked].map((cwd) => {
        expect(existsSync(join(cwd, "package.json"))).toBe(false);
        const record = JSON.parse(runCli(fx, ["status", "--json"], {}, cwd).stdout).workspace;
        expect(readFileSync(join(cwd, "identity.txt"), "utf8")).toBe(record.name);
        expect(readFileSync(join(cwd, "app.env"), "utf8")).toBe(
          `LOCAL=seed\nPORT=${record.ports.api}\n`,
        );
        return record.ports.api;
      });
      expect(ports[0]).not.toBe(ports[1]);
      const pids = [repo, linked].map((cwd) => {
        const up = runDev(fx, ["up"], {}, cwd);
        expect(up.status, up.stderr).toBe(0);
        const pid = Number(readFileSync(join(cwd, "api.pid"), "utf8"));
        expect(running(pid)).toBe(true);
        return pid;
      });
      expect(runDev(fx, ["down"]).status).toBe(0);
      expect(running(pids[0])).toBe(false);
      expect(running(pids[1])).toBe(true);
      expect(runCli(fx, ["remove", linked, "--force", "--json"]).status).toBe(0);
      expect(running(pids[1])).toBe(false);
      expect(existsSync(linked)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

function fixture(): FixtureRepo {
  return createFixtureRepo({ portBlock: PORT_BLOCKS.setup }, (fx) => fixtures.push(fx));
}

function entryFor(repo: string, name: string): WorkspaceEntry {
  const entry = readWorkspaces(repo).workspaces[name];
  if (!entry) throw new Error(`No workspace registered under "${name}"`);
  return entry;
}

function sibling(repo: string, worktreeDir: string): string {
  return join(repo, "..", worktreeDir);
}

function shellRecipe(): WorkspaceManifest {
  const firstPort = 47_100 + 10 * PORT_BLOCKS.setup;
  return {
    workspace: {
      finalize: [{ name: "identity", run: 'printf "%s" "$ALIGNFIRST_NAME" > identity.txt' }],
    },
    devServer: {
      ports: { first: firstPort, last: firstPort + 9, declare: ["api"] },
      runFiles: [
        {
          path: "app.env",
          source: { kind: "content", content: { command: { run: "printf 'LOCAL=seed\\n'" } } },
          patch: {
            command: {
              run: `grep -v '^PORT=' || true; printf 'PORT=%s\\n' "$API_PORT"`,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Manifest interpolation syntax.
              env: { API_PORT: "${{ ports.api }}" },
            },
          },
        },
      ],
      servers: [
        {
          kind: "spawn",
          name: "api",
          exec: { run: 'printf "%s" "$$" > api.pid; echo API_READY; exec sleep 600' },
          ready: { log: "API_READY" },
        },
      ],
    },
  };
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "commit", "-m", message],
    { cwd: repo, stdio: "pipe" },
  );
}

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
