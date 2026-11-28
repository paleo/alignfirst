import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  configureGit,
  git,
  initRepository,
  makeTempDir,
  type RunResult,
  runMain,
} from "./helpers.js";

const roots: string[] = [];

/** A committed repository at `app` with an ignored `.plans`; `target` is a free external path. */
export interface WorkspaceFixture {
  root: string;
  repo: string;
  home: string;
  target: string;
}

export function workspaceFixture(): WorkspaceFixture {
  const root = makeTempDir("alignfirst-workspace-");
  roots.push(root);
  configureGit(root);
  const repo = join(root, "app");
  const home = join(root, "home");
  mkdirSync(home);
  initRepository(repo);
  mkdirSync(join(repo, ".plans"));
  writeFileSync(join(repo, ".gitignore"), "/.plans\n/.local-wt/\n");
  commit(repo);
  return { root, repo, home, target: join(root, "external target") };
}

export function removeWorkspaceFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function runWorkspace(
  fx: WorkspaceFixture,
  args: string[],
  cwd = fx.repo,
): Promise<RunResult> {
  return runMain(["workspace", ...args], {
    cwd,
    home: fx.home,
    env: { ...process.env, HOME: fx.home },
  });
}

export function commit(repo: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "fixture");
}
