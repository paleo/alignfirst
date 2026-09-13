import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import { createBranch, useExistingBranch, type WorktreeContext } from "../src/worktree.js";

// These exercise `worktree.ts` against a real git repo. The functions read the process cwd, so we
// chdir into the fixture repo (vitest's default `forks` pool isolates the cwd mutation per file).
let root: string;
let repo: string;
let ctx: WorktreeContext;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "workspace-worktree-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  // `createBranch` passes `--no-track`; pin the key it neutralises so the assertion cannot pass
  // because of the developer's own `branch.autoSetupMerge`.
  git(["config", "branch.autoSetupMerge", "always"]);
  git(["commit", "--allow-empty", "-m", "init"]);
  process.chdir(repo);
  ctx = { currentWorktree: repo, mainWorktree: repo, isMainWorktree: true };
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const run = { verbose: false };

describe("createBranch conflicts", () => {
  it("throws on an exact conflict without --dedupe, mentioning --dedupe", () => {
    git(["branch", "test"]);
    expect(() => createBranch("test", ctx, run)).toThrow(WorkspaceError);
    expect(() => createBranch("test", ctx, run)).toThrow(/--dedupe/);
  });

  it("suffixes an exact conflict with --dedupe", () => {
    git(["branch", "test"]);
    createBranch("test", ctx, run, { dedupe: true });
    expect(branchExists("test-2")).toBe(true);
    expect(existsSync(join(root, "repo-test-2"))).toBe(true);
  });

  it("throws on a namespace conflict by default, naming the conflicting ref", () => {
    git(["branch", "test/abc"]);
    expect(() => createBranch("test", ctx, run)).toThrow(/test\/abc/);
  });

  it("suffixes a namespace conflict with --dedupe", () => {
    git(["branch", "test/abc"]);
    createBranch("test", ctx, run, { dedupe: true });
    expect(branchExists("test-2")).toBe(true);
    expect(existsSync(join(root, "repo-test-2"))).toBe(true);
  });

  it("throws on an ancestor conflict even with --dedupe", () => {
    git(["branch", "test"]);
    expect(() => createBranch("test/abc", ctx, run, { dedupe: true })).toThrow(WorkspaceError);
    expect(() => createBranch("test/abc", ctx, run, { dedupe: true })).toThrow(/test/);
  });

  it("keeps branch and directory aligned when a candidate directory is taken", () => {
    git(["branch", "test"]);
    mkdirSync(join(root, "repo-test-2"));
    createBranch("test", ctx, run, { dedupe: true });
    expect(branchExists("test-3")).toBe(true);
    expect(existsSync(join(root, "repo-test-3"))).toBe(true);
  });
});

describe("createBranch start point", () => {
  it("does not track a remote branch passed with --from", () => {
    git(["remote", "add", "origin", repo]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["commit", "--allow-empty", "-m", "local commit"]);

    createBranch("feature", ctx, run, { from: "origin/main" });

    expect(gitOutput(["rev-parse", "feature"])).toBe(gitOutput(["rev-parse", "origin/main"]));
    expect(gitOutput(["for-each-ref", "--format=%(upstream:short)", "refs/heads/feature"])).toBe(
      "",
    );
  });
});

describe("worktree error paths", () => {
  it("throws when --from does not resolve", () => {
    expect(() => createBranch("feat", ctx, run, { from: "does-not-exist" })).toThrow(
      WorkspaceError,
    );
  });

  it("throws when the existing branch is missing", () => {
    expect(() => useExistingBranch("nope", ctx, run)).toThrow(WorkspaceError);
  });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

function branchExists(branch: string): boolean {
  const out = execFileSync("git", ["branch", "--list", branch], {
    cwd: repo,
    encoding: "utf-8",
  }).trim();
  return out.length > 0;
}
