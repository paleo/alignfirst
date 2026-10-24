import { execFileSync, spawn, spawnSync } from "node:child_process";
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
// Build tooling stays Node-based; only the CLI parents and fixture children use this runtime.
const childRuntime = process.env.CLI_RUNTIME ?? process.execPath;
const childVersion = execFileSync(childRuntime, ["--version"], { encoding: "utf8" }).trim();
const childUsesBun =
  execFileSync(childRuntime, ["-p", "String(process.versions.bun !== undefined)"], {
    encoding: "utf8",
  }).trim() === "true";

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
  it("keeps counterpart JSON and version probes banner-free through a real npm script", () => {
    const fixture = makeFixture("local");
    const { repo, env, plans } = fixture;
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    const localAlignfirst = join(repo, "node_modules", ".bin", "alignfirst");
    symlinkSync(alignfirst, localAlignfirst);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: { dev: `node ${aligndev}`, af: "echo counterpart-script-must-not-run; exit 99" },
      }),
    );
    mkdirSync(join(plans, "side-1"));
    writeFileSync(join(plans, "side-1", "B1-request.md"), "Offline npm script request.\n");
    const run = (...args: string[]) =>
      spawnSync("npm", ["run", "dev", "--", ...args], {
        cwd: repo,
        env: { ...env, npm_config_offline: "true" },
        encoding: "utf8",
        timeout: 30_000,
      });
    const result = run(
      "code",
      "new",
      "--ticket",
      "side-1",
      "--protocol",
      "spec",
      "--catchup",
      "-m",
      "Read",
      "--quiet",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.home, "agent-prompt.txt"), "utf8")).toContain(
      "npx -y alignfirst guide spec",
    );
    const guide = run("guide", "code");
    expect(guide.status, guide.stderr).toBe(0);
    expect(guide.stdout).toContain("npm run dev -- code");
    expect(guide.stdout).toContain("npx -y alignfirst guide <protocol>");
    rmSync(localAlignfirst);
    writeFileSync(
      localAlignfirst,
      `#!${process.execPath}\nconsole.log(process.argv.includes("--version") ? "0.1.0" : "{}");\n`,
      { mode: 0o755 },
    );
    const failed = run("code", "status", "--no-ticket");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("`npx -y alignfirst`");
    expect(failed.stderr).toContain("version 0.1.0");
    expect(failed.stderr).not.toContain("counterpart-script-must-not-run");
  });

  it("supervises offline agent/quota/catalog processes under the explicit child runtime", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aligndev-process-e2e-"));
    temporary.push(cwd);
    const result = spawnSync(
      childRuntime,
      [fileURLToPath(new URL("process-fixture.mjs", import.meta.url)), cwd],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ runtime: childVersion, checks: "passed" });
  });

  it("retains nonzero exits and a failed durable session", () => {
    const { repo, env, sessions } = makeFixture("local");
    const result = cli(
      aligndev,
      repo,
      { ...env, TEST_AGENT_MODE: "failure" },
      "code",
      "new",
      "-m",
      "Fail offline",
      "--quiet",
    );
    expect(result.status, result.stderr).toBe(1);
    const records = readdirSync(join(sessions, "_aligndev"));
    expect(records).toHaveLength(1);
    expect(readFileSync(join(sessions, "_aligndev", records[0] ?? ""), "utf8")).toContain(
      "status: failed",
    );
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "seals sessions and escalates TERM-resistant children after %s",
    async (signal, exitCode) => {
      const fixture = makeFixture("local");
      const { repo, env, home, sessions } = fixture;
      const child = spawn(
        childRuntime,
        [aligndev, "code", "new", "-m", "Wait offline", "--quiet"],
        {
          cwd: repo,
          env: { ...env, TEST_AGENT_MODE: "resistant" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.resume();
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
          child.once("error", reject);
        },
      );
      let agentPid: number | undefined;
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await waitUntil(() => existsSync(join(home, "agent-ready")));
        agentPid = Number(readFileSync(join(home, "agent-ready"), "utf8"));
        const started = Date.now();
        child.kill(signal);
        const outcome = await closed;
        expect(outcome, stderr).toEqual({ code: exitCode, signal: null });
        expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
        await waitUntil(() => !isExecuting(agentPid));
        const records = readdirSync(join(sessions, "_aligndev"));
        expect(records).toHaveLength(1);
        expect(records[0]).not.toContain(".running.");
        const text = readFileSync(join(sessions, "_aligndev", records[0] ?? ""), "utf8");
        expect(text).toContain("status: failed");
        expect(text).toContain("exitReason: terminated");
      } finally {
        clearTimeout(deadline);
        if (agentPid !== undefined && isExecuting(agentPid)) process.kill(agentPid, "SIGKILL");
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
    15_000,
  );
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
      const doctor = cli(alignfirst, destination, env, "doctor");
      expect(doctor.status, doctor.stderr).toBe(0);
      expect(doctor.stdout).toContain("embedded docmap");
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
        "--protocol",
        "spec",
        "--catchup",
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
      const prompt = readFileSync(join(fixture.home, "agent-prompt.txt"), "utf8");
      expect(prompt).toContain(
        `${childUsesBun ? "bunx --bun alignfirst" : "alignfirst"} guide spec`,
      );
      expect(prompt).toContain("Worktree test.");
      const resumed = cli(
        aligndev,
        destination,
        env,
        "code",
        "resume",
        "fixture-session",
        "-m",
        "Continue.",
        "--quiet",
      );
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(readdirSync(sessionDirectory)).toHaveLength(2);
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
  writeFileSync(alignfirstShim, `#!${childRuntime}\nimport(${JSON.stringify(alignfirst)});\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, "claude"),
    `#!${childRuntime}
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(process.env.HOME, "agent-prompt.txt"), input);
  if (process.env.TEST_AGENT_MODE === "failure") { process.stderr.write("offline failure"); process.exit(7); }
  if (process.env.TEST_AGENT_MODE === "resistant") {
    process.on("SIGTERM", () => {});
    fs.writeFileSync(path.join(process.env.HOME, "agent-ready"), String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
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
  writeFileSync(
    join(bin, "bunx"),
    `#!${childRuntime}
const args = process.argv.slice(2);
if (args[0] === "--bun") args.shift();
if (args.shift() !== "alignfirst") process.exit(99);
process.argv = [process.execPath, ${JSON.stringify(alignfirst)}, ...args];
import(${JSON.stringify(alignfirst)});
`,
    { mode: 0o755 },
  );
  env.TEST_PLANS = plans;
  return { home, repo, destination, plans, sessions, env };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture process.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isExecuting(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    // A killed orphan may briefly remain as a zombie until the host init reaps it.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
}

function cli(entry: string, cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(childRuntime, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}
