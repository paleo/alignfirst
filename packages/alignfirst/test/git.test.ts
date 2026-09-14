import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { git as runGit } from "../src/git.js";
import { configureGit, git, makeSink, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git failures", () => {
  it("carries git's own message when nothing was printed", async () => {
    const dir = makeFixture();
    const result = await runMain(["plans", "setup", "clone", "--folder", "product"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git rev-parse failed:");
    expect(result.stderr).toContain("not a git repository");
  });

  it("writes git output to the streams and names the subcommand past global options", () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    const stdout = makeSink();
    const stderr = makeSink();
    expect(() =>
      runGit({ stdout, stderr }, dir, "-c", "core.editor=true", "rebase", "--continue"),
    ).toThrow("git rebase failed. See the git output above.");
    expect(stderr.text()).toContain("no rebase in progress");
  });
});

function makeFixture(): string {
  const dir = makeTempDir("alignfirst-git-");
  dirs.push(dir);
  configureGit(dir);
  return dir;
}
