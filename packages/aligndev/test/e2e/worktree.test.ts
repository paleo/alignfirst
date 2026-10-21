import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeConfig, writeRegistry } from "../helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const aligndev = join(root, "packages/aligndev/bin/aligndev.mjs");
const alignfirst = join(root, "packages/alignfirst/bin/alignfirst.mjs");
const temporary: string[] = [];

interface Fixture {
  home: string;
  repo: string;
  destination: string;
  plans: string;
  sessions: string;
  env: NodeJS.ProcessEnv;
}

beforeAll(() => {
  for (const workspace of ["@alignfirst/docmap", "alignfirst", "aligndev"]) {
    execFileSync("npm", ["run", "build", "--workspace", workspace], { cwd: root, stdio: "pipe" });
  }
}, 60_000);

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("built worktree CLI lifecycle", () => {
  it.each(["local", "shared", "companion", "separateSessions"])(
    "keeps config, context, tickets, sync and coding sessions in %s plans",
    (mode) => {
      const fixture = makeFixture(mode);
      const { repo, destination, plans, sessions, env } = fixture;
      const mainBranch = git(repo, env, "branch", "--show-current");
      const added = cli(
        aligndev,
        repo,
        env,
        "worktree",
        "add",
        destination,
        "-b",
        "side-1/work",
        "main",
        "--json",
      );
      expect(added.status, added.stderr).toBe(0);
      const addition = JSON.parse(added.stdout);
      expect(addition.worktree.branch).toBe("side-1/work");
      expect(addition.directories[".plans"].mode).toBe(
        mode === "companion" ? "companion" : "symlink",
      );
      expect(git(repo, env, "branch", "--show-current")).toBe(mainBranch);
      expect(git(destination, env, "status", "--porcelain")).toBe("");
      if (mode === "companion") {
        expect(readFileSync(join(destination, ".plans", "unused-tracked.md"), "utf8")).toContain(
          "untouched",
        );
        expect(existsSync(join(plans, "unused-tracked.md"))).toBe(false);
      }

      const config = cli(alignfirst, destination, env, "config", "--json");
      expect(config.status, config.stderr).toBe(0);
      const locations = JSON.parse(config.stdout).locations;
      expect(realpathSync(locations[".plans"].path)).toBe(plans);
      expect(realpathSync(locations._aligndev.path)).toBe(sessions);
      const context = cli(alignfirst, destination, env, "context");
      expect(context.status, context.stderr).toBe(0);
      expect(context.stdout).toContain(mode === "companion" ? plans : ".plans");
      const ticket = cli(alignfirst, destination, env, "ticket", "side-1", "--json");
      expect(ticket.status, ticket.stderr).toBe(0);
      expect(existsSync(join(plans, "side-1"))).toBe(true);
      writeFileSync(join(plans, "side-1", "B1-request.md"), "# Request\n\nWorktree test.\n");

      const launched = cli(
        aligndev,
        destination,
        env,
        "code",
        "new",
        "--ticket",
        "side-1",
        "-m",
        "Read and update work files.",
        "--quiet",
      );
      expect(launched.status, launched.stderr).toBe(0);
      const sessionDirectory = join(sessions, "side-1", "_aligndev");
      const records = readdirSync(sessionDirectory);
      expect(records).toHaveLength(1);
      const filename = records[0];
      if (filename === undefined) throw new Error("Coding launch did not create a session file.");
      const record = join(sessionDirectory, filename);
      expect(readFileSync(record, "utf8")).toContain("status: succeeded");
      expect(readFileSync(record, "utf8")).toContain(`cwd: ${destination}`);
      expect(readFileSync(join(plans, "side-1", "B2-agent.md"), "utf8")).toContain(
        "Worktree test.",
      );
      const invocation = JSON.parse(readFileSync(join(fixture.home, "agent-args.json"), "utf8"));
      expect(invocation).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
      expect(invocation).not.toContain("--dangerously-skip-permissions");
      if (mode === "companion" || mode === "separateSessions") {
        expect(invocation).toEqual(expect.arrayContaining(["--add-dir", dirname(sessions)]));
      }
      const historical = cli(
        aligndev,
        destination,
        env,
        "code",
        "status",
        "--ticket",
        "side-1",
        "--result",
      );
      expect(historical.status, historical.stderr).toBe(0);
      expect(historical.stdout).toContain("fixture complete");
      const sync = cli(alignfirst, destination, env, "sync");
      expect(sync.status, sync.stderr).toBe(0);
      if (mode === "shared") {
        expect(git(dirname(plans), env, "status", "--porcelain")).toBe("");
        expect(git(dirname(plans), env, "log", "-1", "--format=%s")).not.toBe("initial");
      }
      const removed = cli(aligndev, destination, env, "worktree", "remove", destination, "--json");
      expect(removed.status, removed.stderr).toBe(0);
      expect(JSON.parse(removed.stdout).removed).toBe(true);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(record)).toBe(true);
      expect(existsSync(join(plans, "side-1", "B1-request.md"))).toBe(true);
      expect(git(repo, env, "branch", "--list", "side-1/work")).toContain("side-1/work");
      const listed = cli(aligndev, repo, env, "worktree", "list", "--json");
      expect(JSON.parse(listed.stdout).worktrees).toHaveLength(1);
    },
  );
});

function makeFixture(mode: string): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aligndev-worktree-e2e-")));
  temporary.push(base);
  const home = join(base, "home");
  const repo = join(base, "app");
  const destination = join(base, "app side-1");
  const bin = join(base, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const globalConfig = join(base, "gitconfig");
  writeFileSync(globalConfig, "[user]\nname = Test\nemail = test@example.com\n");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    ALIGNFIRST_ARCHIVE_THRESHOLD_DAYS: "99999",
  };
  git(base, env, "init", "--quiet", "--initial-branch=main", repo);
  writeFileSync(join(repo, "README.md"), "# App\n");
  git(repo, env, "add", "README.md");
  git(repo, env, "commit", "--quiet", "-m", "initial");
  let plans = join(repo, ".plans");
  if (mode === "shared") {
    const workfiles = join(base, "workfiles");
    const origin = join(base, "origin.git");
    git(base, env, "init", "--quiet", "--bare", origin);
    git(base, env, "init", "--quiet", "--initial-branch=main", workfiles);
    mkdirSync(join(workfiles, "app"));
    writeFileSync(join(workfiles, "README.md"), "Work files\n");
    git(workfiles, env, "add", "README.md");
    git(workfiles, env, "commit", "--quiet", "-m", "initial");
    git(workfiles, env, "remote", "add", "origin", origin);
    git(workfiles, env, "push", "--quiet", "-u", "origin", "main");
    plans = join(workfiles, "app");
    symlinkSync(plans, join(repo, ".plans"));
  } else mkdirSync(plans);
  let sessions = plans;
  if (mode === "companion" || mode === "separateSessions") {
    const companion = join(home, ".alignfirst", "companions", "app");
    mkdirSync(join(companion, ".plans"), { recursive: true });
    writeRegistry(home, {
      projects: {
        [repo]: {
          dir: "app",
          items: {
            ".plans": mode === "companion" ? "companion" : "project",
            _aligndev: "companion",
          },
        },
      },
    });
    sessions = join(companion, ".plans");
    if (mode === "companion") {
      writeFileSync(join(plans, "unused-tracked.md"), "This project copy stays untouched.\n");
      git(repo, env, "add", ".plans");
      git(repo, env, "commit", "--quiet", "-m", "unused project plans");
      plans = sessions;
    }
  }
  writeConfig(home, { code: { agent: "claude", defaultModel: "haiku" } });
  const alignfirstShim = join(bin, "alignfirst");
  writeFileSync(alignfirstShim, `#!${process.execPath}\nimport(${JSON.stringify(alignfirst)});\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const plans = process.env.TEST_PLANS;
  const request = fs.readFileSync(path.join(plans, "side-1/B1-request.md"), "utf8");
  fs.writeFileSync(path.join(plans, "side-1/B2-agent.md"), request);
  fs.writeFileSync(path.join(process.env.HOME, "agent-args.json"), JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({type: "system", subtype: "init", session_id: "fixture-session"}));
  console.log(JSON.stringify({type: "result", session_id: "fixture-session", result: "fixture complete", is_error: false}));
});
`,
    { mode: 0o755 },
  );
  env.TEST_PLANS = plans;
  return { home, repo, destination, plans, sessions, env };
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
}

function cli(entry: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}
