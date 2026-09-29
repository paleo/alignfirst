import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // A projects directory, also the default working directory.
  root: string;
  // The injected home, also `HOME` for alignfirst, without an aldev config unless a test writes one.
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
    gitConfigDir = mkdtempSync(join(tmpdir(), "aldev-git-"));
    gitConfigPath = join(gitConfigDir, "gitconfig");
    writeFileSync(gitConfigPath, "");
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

export function makeFixture(marker?: object): Fixture {
  const base = mkdtempSync(join(tmpdir(), "aldev-projects-"));
  fixtureDirs.push(base);
  const root = join(base, "projects");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  if (marker !== undefined) writeMarker(root, marker);
  return { base, root, home };
}

export async function runAldev(
  fixture: Fixture,
  args: string[],
  overrides: RunOverrides = {},
): Promise<RunResult> {
  const stdout = makeSink();
  const stderr = makeSink();
  const home = overrides.home ?? fixture.home;
  // Under `npm test`, npm sets its user agent: the guides would print the npx forms.
  const { npm_config_user_agent: _userAgent, ...baseEnv } = process.env;
  const env = { ...baseEnv, HOME: home };
  Object.assign(env, overrides.env);
  const code = await main({
    argv: ["node", "aldev", ...args],
    cwd: overrides.cwd ?? fixture.root,
    home,
    env: { ...env, GIT_CONFIG_GLOBAL: gitConfigPath },
    alignfirstCommand: overrides.alignfirstCommand ?? ["node", ALIGNFIRST_BIN],
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function makeProjectsDirectory(parent: string, name: string, marker: object): string {
  const directory = join(parent, name);
  mkdirSync(directory);
  writeMarker(directory, marker);
  return directory;
}

export function makeRepository(parent: string, name: string, config?: object): string {
  const repository = join(parent, name);
  execGit(parent, "init", "--quiet", "--initial-branch=main", repository);
  execGit(repository, "config", "user.name", "Test");
  execGit(repository, "config", "user.email", "test@example.com");
  writeFileSync(join(repository, "README.md"), `${name}\n`);
  execGit(repository, "add", "README.md");
  execGit(repository, "commit", "--quiet", "-m", "initial");
  if (config !== undefined) writeProjectConfig(repository, config);
  return realpathSync(repository);
}

export function writeProjectConfig(directory: string, config: object): void {
  writeFileSync(
    join(directory, ".alignfirst.json"),
    `${JSON.stringify({ schemaVersion: 1, ...config }, undefined, 2)}\n`,
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

export function writeMarker(directory: string, marker: object): void {
  writeFileSync(
    join(directory, ".alignfirst-projects.json"),
    `${JSON.stringify(marker, undefined, 2)}\n`,
  );
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function range(first: number, last: number): { first: number; last: number } {
  return { first, last };
}
