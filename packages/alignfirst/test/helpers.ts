import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import type { Output } from "../src/context.js";

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
    home: options.home,
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
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
}
