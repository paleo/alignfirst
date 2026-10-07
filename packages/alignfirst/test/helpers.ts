import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import type { Output } from "../src/context.js";

export const packageVersion = readPackageVersion();

/** Keeps the developer's `~/.alignfirst/companions.json` out of the tests. */
const DEFAULT_HOME = mkdtempSync(join(tmpdir(), "alignfirst-home-"));

export interface Sink extends Output {
  text(): string;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function makeSink(): Sink {
  let buffer = "";
  return {
    write(text: string) {
      buffer += text;
    },
    text: () => buffer,
  };
}

export async function runMain(args: string[], options: RunOptions): Promise<RunResult> {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "alignfirst", ...args],
    cwd: options.cwd,
    env: options.env ?? {},
    home: options.home ?? DEFAULT_HOME,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function makeTempDir(prefix = "alignfirst-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function configureGit(dir: string): void {
  const config = join(dir, "gitconfig");
  writeFileSync(
    config,
    "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Initializes a repository with one commit; call `configureGit` first. */
export function initRepository(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  writeFileSync(join(dir, "README.md"), "project\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "--quiet", "-m", "init");
}

export function writeCompanions(home: string, value: unknown): void {
  const dir = join(home, ".alignfirst");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "companions.json"), JSON.stringify(value));
}

export interface CompanionProject {
  root: string;
  home: string;
  project: string;
  companion: string;
}

/** A repository at `~/app` whose companion is `~/companions/app`; the caller removes `root`. */
export function makeCompanionProject(flags: Record<string, unknown>): CompanionProject {
  const root = makeTempDir("alignfirst-companion-");
  configureGit(root);
  const home = join(root, "home");
  const project = join(home, "app");
  initRepository(project);
  writeCompanions(home, { root: "~/companions", paths: { "~/app": flags } });
  return { root, home, project, companion: join(home, "companions", "app") };
}

function readPackageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("alignfirst test: package.json is missing 'version'");
  return manifest.version;
}
