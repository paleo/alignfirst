import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { optionalRepositoryId, git as runGit } from "../src/git.js";
import { configureGit, git, makeSink, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git failures", () => {
  it("propagates a missing Git executable instead of treating the directory as outside Git", () => {
    const dir = makeFixture();
    vi.stubEnv("PATH", dir);
    expect(() => optionalRepositoryId(dir)).toThrow("ENOENT");
  });

  it("propagates an invalid explicit Git directory instead of treating it as discovery absence", () => {
    const dir = makeFixture();
    vi.stubEnv("GIT_DIR", join(dir, "missing"));
    expect(() => optionalRepositoryId(dir)).toThrow("not a git repository:");
  });

  it("carries git's own message when nothing was printed", async () => {
    const dir = makeFixture();
    const result = await runMain(["plans", "setup", "clone", "--folder", "product"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git rev-parse failed:");
    expect(result.stderr).toContain("not a git repository");
  });

  it("writes git output to the streams and names the subcommand past global options", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    const stdout = makeSink();
    const stderr = makeSink();
    await expect(
      runGit({ stdout, stderr }, dir, "-c", "core.editor=true", "rebase", "--continue"),
    ).rejects.toThrow("git rebase failed. See the git output above.");
    // Git 2.39 prints "No rebase in progress?".
    expect(stderr.text()).toMatch(/no rebase in progress/i);
  });

  it("streams output beyond the synchronous child-process buffer limit", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    const contents = "x".repeat(2 * 1024 * 1024);
    writeFileSync(join(dir, "large.txt"), contents);
    git(dir, "add", "large.txt");
    git(dir, "commit", "--quiet", "-m", "large output");
    const stdout = makeSink();
    const stderr = makeSink();
    await runGit({ stdout, stderr }, dir, "show", "HEAD:large.txt");
    expect(stdout.text()).toBe(contents);
    expect(stderr.text()).toBe("");
  });
});

function makeFixture(): string {
  const dir = makeTempDir("alignfirst-git-");
  dirs.push(dir);
  configureGit(dir);
  return dir;
}
