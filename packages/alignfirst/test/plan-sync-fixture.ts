import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

/** A product whose `.plans` links to `product-plans` in `clone`; `other` is a second clone of `remote`. */
export interface SyncFixture {
  root: string;
  product: string;
  clone: string;
  other: string;
  remote: string;
}

export async function makeSyncFixture(initial: Record<string, string> = {}): Promise<SyncFixture> {
  const root = makeTempDir("alignfirst-conflicts-");
  dirs.push(root);
  configureGit(root);
  const product = join(root, "product");
  const clone = join(root, "plans");
  const remote = join(root, "remote.git");
  const other = join(root, "other");
  git(root, "init", "--bare", "--quiet", remote);
  git(root, "clone", "--quiet", remote, clone);
  write(clone, "README.md", "Plans\n");
  write(clone, "product-plans/.gitkeep", "");
  for (const [path, content] of Object.entries(initial)) write(clone, path, content);
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "base");
  git(clone, "push", "--quiet", "-u", "origin", "HEAD");
  git(root, "clone", "--quiet", remote, other);
  git(root, "init", "--quiet", product);
  const setup = await runMain(["plans", "setup", clone, "--folder", "product-plans"], {
    cwd: product,
  });
  expect(setup.code, setup.stderr).toBe(0);
  return { root, product, clone, other, remote };
}

export function removeSyncFixtures(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function write(repo: string, path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function commitLocal(fixture: SyncFixture, message: string): void {
  git(fixture.clone, "add", "-A");
  git(fixture.clone, "commit", "--quiet", "-m", message);
}

export function publishOther(fixture: SyncFixture): void {
  git(fixture.other, "add", "-A");
  git(fixture.other, "commit", "--quiet", "-m", "remote");
  git(fixture.other, "push", "--quiet");
}

export function remoteContent(fixture: SyncFixture, path: string): string {
  return execFileSync("git", ["-C", fixture.remote, "show", `HEAD:${path}`], { encoding: "utf8" });
}
