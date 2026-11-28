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
import { afterEach, describe, expect, it } from "vitest";

import { writeConfig, writeRegistry } from "../helpers.js";

type Mode = "local" | "separateSessions";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const aligndev = join(root, "packages/aligndev/bin/aligndev.mjs");
const alignfirst = join(root, "packages/alignfirst/bin/alignfirst.mjs");
const temporary: string[] = [];
// Build tooling stays Node-based; only the CLI parents and fixture children use this runtime.
const childRuntime = process.env.CLI_RUNTIME ?? process.execPath;
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

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("built worktree CLI lifecycle", () => {
  it("seals sessions and escalates TERM-resistant children after SIGTERM", async () => {
    const fixture = makeFixture("local");
    const { repo, env, home, sessions } = fixture;
    const child = spawn(childRuntime, [aligndev, "code", "new", "-m", "Wait offline", "--quiet"], {
      cwd: repo,
      env: { ...env, TEST_AGENT_MODE: "resistant" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      child.kill("SIGTERM");
      const outcome = await closed;
      expect(outcome, stderr).toEqual({ code: 143, signal: null });
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
  }, 15_000);
  it("keeps coding sessions of a plain linked worktree in the companion sessions tree", () => {
    const fixture = makeFixture("separateSessions");
    const { repo, destination, plans, sessions, env } = fixture;
    git(repo, env, "worktree", "add", "--quiet", "-b", "side-1/work", destination, "main");
    symlinkSync(plans, join(destination, ".plans"));
    mkdirSync(join(plans, "side-1"));
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
    const record = readFileSync(join(sessionDirectory, records[0] ?? ""), "utf8");
    expect(record).toContain("status: succeeded");
    expect(record).toContain(`cwd: ${destination}`);
    const args = readFileSync(join(fixture.home, "agent-args.txt"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", dirname(sessions)]));
    const prompt = readFileSync(join(fixture.home, "agent-prompt.txt"), "utf8");
    expect(prompt).toContain(`${childUsesBun ? "bunx --bun alignfirst" : "alignfirst"} guide spec`);
    expect(prompt).toContain("Worktree test.");

    const status = cli(
      aligndev,
      destination,
      env,
      "code",
      "status",
      "--ticket",
      "side-1",
      "--result",
    );
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("fixture complete");
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
  }, 30_000);
});

function makeFixture(mode: Mode): Fixture {
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
  writeFileSync(join(repo, ".gitignore"), "/.plans\n/.local\n/.local-wt/\n");
  git(repo, env, "add", ".gitignore");
  git(repo, env, "commit", "--quiet", "-m", "initial");
  const plans = join(repo, ".plans");
  mkdirSync(plans);
  let sessions = plans;
  if (mode === "separateSessions") {
    const companion = join(home, ".alignfirst", "companions", "app");
    mkdirSync(join(companion, ".plans"), { recursive: true });
    writeRegistry(home, {
      projects: { [repo]: { dir: "app", items: { ".plans": "project", _aligndev: "companion" } } },
    });
    sessions = join(companion, ".plans");
  }
  writeConfig(home, { code: { harness: "claude", defaultModel: "haiku" } });
  const alignfirstShim = join(bin, "alignfirst");
  writeFileSync(alignfirstShim, `#!${childRuntime}\nimport(${JSON.stringify(alignfirst)});\n`, {
    mode: 0o755,
  });
  // A TERM-resistant agent under TEST_AGENT_MODE=resistant, else a successful one.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
cat > "$HOME/agent-prompt.txt"
if [ "$TEST_AGENT_MODE" = resistant ]; then
  trap '' TERM
  printf '%s' "$$" > "$HOME/agent-ready"
  exec sleep 30
fi
for arg in "$@"; do printf '%s\\n' "$arg"; done > "$HOME/agent-args.txt"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fixture-session"}'
printf '%s\\n' '{"type":"result","session_id":"fixture-session","result":"fixture complete","is_error":false}'
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
