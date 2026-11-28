import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll } from "vitest";

import { main } from "../../src/cli.js";
import { ALIGNFIRST_BIN, makeSink } from "../helpers.js";

const fixtureDirs: string[] = [];
let gitConfigDir: string;
let gitConfigPath: string;
let originalGitConfig: string | undefined;

export interface Fixture {
  base: string;
  // The scan root, also the default working directory.
  root: string;
  // The injected home, also `HOME` for alignfirst, without aligndev settings unless a test writes them.
  home: string;
}

export interface RunOverrides {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  alignfirstCommand?: string[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Registers the hooks that isolate git from the developer's global config and remove fixtures.
export function useProjectFixtures(): void {
  beforeAll(() => {
    gitConfigDir = mkdtempSync(join(tmpdir(), "aligndev-git-"));
    gitConfigPath = join(gitConfigDir, "gitconfig");
    writeFileSync(gitConfigPath, "[user]\n\tname = Test\n\temail = test@example.com\n");
    originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  });
  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => {
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
    rmSync(gitConfigDir, { recursive: true, force: true });
  });
}

export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "aligndev-projects-"));
  fixtureDirs.push(base);
  const root = join(base, "projects");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  return { base, root, home };
}

export async function runAligndev(
  fixture: Fixture,
  args: string[],
  overrides: RunOverrides = {},
): Promise<RunResult> {
  const stdout = makeSink();
  const stderr = makeSink();
  const home = overrides.home ?? fixture.home;
  // Under `npm test`, npm sets its user agent: the guides would print the npx forms. A coding agent
  // or an OpenClaw exec running the tests would set the assistant's harness.
  const {
    npm_config_user_agent: _userAgent,
    npm_execpath: _npmExecpath,
    npm_command: _npmCommand,
    npm_lifecycle_event: _npmEvent,
    npm_lifecycle_script: _npmScript,
    npm_package_json: _npmManifest,
    CLAUDECODE: _claude,
    CODEX_THREAD_ID: _codex,
    PI_CODING_AGENT: _pi,
    AI_AGENT: _agent,
    ANTIGRAVITY_AGENT: _agy,
    OPENCLAW_SHELL: _openclaw,
    ALIGNDEV_ASSISTANT_HARNESS: _harness,
    ...baseEnv
  } = process.env;
  const env = { ...baseEnv, HOME: home };
  Object.assign(env, overrides.env);
  const code = await main({
    argv: ["node", "aligndev", ...args],
    cwd: overrides.cwd ?? fixture.root,
    home,
    env: { ...env, GIT_CONFIG_GLOBAL: gitConfigPath },
    alignfirstCommand: overrides.alignfirstCommand ?? ["node", ALIGNFIRST_BIN],
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// An empty repository; `git worktree add` needs `addInitialCommit` first.
export function makeRepository(parent: string, name: string, config?: object): string {
  const repository = join(parent, name);
  execGit(parent, "init", "--quiet", "--initial-branch=main", repository);
  if (config !== undefined) writeProjectConfig(repository, config);
  return realpathSync(repository);
}

export function addInitialCommit(repository: string): void {
  execGit(repository, "commit", "--quiet", "--allow-empty", "-m", "initial");
}

// Inventory fixtures supply the range separately from convention settings.
export function writeProjectConfig(
  directory: string,
  settings: object & {
    portRange?: { first: number; last: number };
    ticketIdPattern?: string;
    git?: object;
    assistantInstructionsFile?: string;
  },
): void {
  const { portRange, ticketIdPattern, git, ...config } = settings;
  const devServer =
    portRange === undefined
      ? undefined
      : {
          ports: { ...portRange, declare: ["app"] },
          servers: [
            {
              kind: "spawn",
              name: "app",
              exec: { run: ["python", "app.py"] },
              ready: { log: "ready" },
            },
          ],
        };
  writeFileSync(
    join(directory, "alignfirst.json"),
    JSON.stringify({
      schemaVersion: 1,
      assistantInstructionsFile: "DEVELOPERS.md",
      ...config,
      conventions: { ticketIdPattern, git },
      ...(devServer === undefined ? {} : { devServer }),
    }),
  );
}

export function addWorktree(main: string, worktree: string, branch: string): void {
  execGit(main, "worktree", "add", "--quiet", "-b", branch, worktree);
}

export function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
  }).trim();
}

export function range(first: number, last: number): { first: number; last: number } {
  return { first, last };
}
