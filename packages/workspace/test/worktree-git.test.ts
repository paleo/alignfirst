import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import { headCommit } from "../src/git.js";
import { createBranch, type WorktreeContext } from "../src/worktree.js";

// These exercise `worktree.ts` against one real git repo, with fresh branch names per case. The
// functions read the process cwd, so we chdir into the fixture repo (vitest's default `forks` pool
// isolates the cwd mutation per file).
let root: string;
let repo: string;
let ctx: WorktreeContext;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "workspace-worktree-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  // `createBranch` passes `--no-track`; pin the key it neutralises so the assertion cannot pass
  // because of the developer's own `branch.autoSetupMerge`.
  git(["config", "branch.autoSetupMerge", "always"]);
  git(["commit", "--allow-empty", "-m", "init"]);
  process.chdir(repo);
  ctx = { currentWorktree: repo, mainWorktree: repo, isMainWorktree: true };
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const run = { verbose: false };

describe("createBranch conflicts", () => {
  it.each<[string, string[], string, boolean, string | undefined, string?]>([
    ["an exact conflict", ["exact"], "exact", false, undefined],
    ["an exact conflict with --dedupe", ["exactd"], "exactd", true, "exactd-2"],
    ["a namespace conflict", ["space/abc"], "space", false, undefined],
    ["a namespace conflict with --dedupe", ["spaced/abc"], "spaced", true, "spaced-2"],
    ["an ancestor conflict even with --dedupe", ["ancestor"], "ancestor/abc", true, undefined],
    ["a taken candidate directory", ["aligned"], "aligned", true, "aligned-3", "repo-aligned-2"],
  ])("resolves %s", (_, existing, requested, dedupe, created, takenDir) => {
    for (const branch of existing) git(["branch", branch]);
    if (takenDir !== undefined) mkdirSync(join(root, takenDir));
    if (created === undefined) {
      expect(() => createBranch(requested, ctx, run, { dedupe })).toThrow(WorkspaceError);
      return;
    }
    createBranch(requested, ctx, run, { dedupe });
    expect(branchExists(created)).toBe(true);
    expect(existsSync(join(root, `repo-${created}`))).toBe(true);
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

  it("throws when --from does not resolve", () => {
    expect(() => createBranch("feat", ctx, run, { from: "does-not-exist" })).toThrow(
      WorkspaceError,
    );
  });
});

describe("headCommit", () => {
  it("distinguishes an unborn HEAD from a broken or non-commit branch", () => {
    const unborn = join(root, "unborn");
    mkdirSync(unborn);
    git(["init", "-b", "main"], unborn);
    git(["commit", "--allow-empty", "-m", "init"], unborn);
    const source = { cwd: unborn, env: process.env };
    const head = gitOutput(["rev-parse", "HEAD"], unborn);
    expect(headCommit(source)).toBe(head);
    git(["update-ref", "-d", "refs/heads/main"], unborn);
    expect(headCommit(source)).toBeUndefined();
    writeFileSync(join(unborn, ".git/refs/heads/main"), `${"1".repeat(40)}\n`);
    expect(() => headCommit(source)).toThrow();
    const tree = gitOutput(["rev-parse", `${head}^{tree}`], unborn);
    writeFileSync(join(unborn, ".git/refs/heads/main"), `${tree}\n`);
    expect(() => headCommit(source)).toThrow(Error);
  });
});

function git(args: string[], cwd = repo): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  });
}

function gitOutput(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function branchExists(branch: string): boolean {
  const out = execFileSync("git", ["branch", "--list", branch], {
    cwd: repo,
    encoding: "utf-8",
  }).trim();
  return out.length > 0;
}
