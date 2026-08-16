import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";

let suiteDir: string;
let fixtureDir: string;

beforeAll(() => {
  suiteDir = mkdtempSync(join(tmpdir(), "plans-share-suite-"));
  const gitConfig = join(suiteDir, "gitconfig");
  writeFileSync(
    gitConfig,
    "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  product: string;
  remoteUrl: string;
}

function makeFixture(): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "plans-share-"));
  const remoteUrl = join(fixtureDir, "remote.git");
  execGit(fixtureDir, "init", "--quiet", "--bare", remoteUrl);
  execGit(fixtureDir, "clone", "--quiet", remoteUrl, join(fixtureDir, "team-plans"));
  const product = join(fixtureDir, "product");
  execGit(fixtureDir, "init", "--quiet", product);
  writeFileSync(join(product, "README.md"), "product\n");
  execGit(product, "add", "-A");
  execGit(product, "commit", "--quiet", "-m", "init");
  return { root: fixtureDir, product, remoteUrl };
}

function execGit(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, ...args: string[]): RunResult {
  let stdout = "";
  let stderr = "";
  const code = main({
    argv: ["node", "plans-share", ...args],
    cwd,
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  });
  return { code, stdout, stderr };
}

function runSetup(fixture: Fixture, dir = join(fixture.root, "team-plans")): RunResult {
  return run(fixture.product, "setup", dir, "--folder", "myproj");
}

describe("plans-share setup", () => {
  it("links .plans to an existing clone", () => {
    const fixture = makeFixture();
    const result = runSetup(fixture);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(lstatSync(join(fixture.product, ".plans")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(join("..", "team-plans", "myproj"));
    expect(existsSync(join(fixture.root, "team-plans", "myproj"))).toBe(true);
  });

  it("migrates existing .plans content into the clone", () => {
    const fixture = makeFixture();
    const ticketDir = join(fixture.product, ".plans", "123");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(join(ticketDir, "A1-spec.md"), "spec\n");
    const result = runSetup(fixture);
    expect(result.code).toBe(0);
    expect(existsSync(join(fixture.root, "team-plans", "myproj", "123", "A1-spec.md"))).toBe(true);
    expect(lstatSync(join(fixture.product, ".plans")).isSymbolicLink()).toBe(true);
  });

  it("reports all migration collisions without copying anything", () => {
    const fixture = makeFixture();
    const cloneDir = join(fixture.root, "team-plans");
    mkdirSync(join(cloneDir, "myproj", "123"), { recursive: true });
    mkdirSync(join(cloneDir, "myproj", "456"), { recursive: true });
    mkdirSync(join(fixture.product, ".plans", "123"), { recursive: true });
    mkdirSync(join(fixture.product, ".plans", "456"), { recursive: true });
    mkdirSync(join(fixture.product, ".plans", "789"), { recursive: true });
    const result = runSetup(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("123, 456");
    expect(existsSync(join(cloneDir, "myproj", "789"))).toBe(false);
    expect(lstatSync(join(fixture.product, ".plans")).isDirectory()).toBe(true);
  });

  it("is idempotent once linked", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = runSetup(fixture);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already links");
  });

  it("fails when the directory does not exist", () => {
    const fixture = makeFixture();
    const result = runSetup(fixture, join(fixture.root, "nowhere"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });

  it("fails when the directory is not a git repository", () => {
    const fixture = makeFixture();
    const plainDir = join(fixture.root, "plain");
    mkdirSync(plainDir);
    const result = runSetup(fixture, plainDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a git repository");
  });

  it("fails when the directory is the product repository itself", () => {
    const fixture = makeFixture();
    const result = runSetup(fixture, fixture.product);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("product repository itself");
  });

  it("re-links after the clone moved", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const movedDir = join(fixture.root, "moved-plans");
    renameSync(join(fixture.root, "team-plans"), movedDir);
    const result = runSetup(fixture, movedDir);
    expect(result.code).toBe(0);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(join("..", "moved-plans", "myproj"));
  });

  it("refuses to run from a linked worktree", () => {
    const fixture = makeFixture();
    const worktree = join(fixture.root, "product-feat");
    execGit(fixture.product, "worktree", "add", "--quiet", worktree, "-b", "feat");
    const result = run(worktree, "setup", join(fixture.root, "team-plans"), "--folder", "myproj");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("main worktree");
  });
});

describe("plans-share check", () => {
  it("succeeds when .plans is linked to a plans repository", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = run(fixture.product, "check");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("linked to the team plans repository");
  });

  it("fails when .plans is missing", () => {
    const fixture = makeFixture();
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Clone the team plans repository");
  });

  it("fails when .plans is a plain directory", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not linked");
  });

  it("fails when the .plans symlink is broken", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    renameSync(join(fixture.root, "team-plans"), join(fixture.root, "moved-plans"));
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken");
  });

  it("fails when .plans is a regular file", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.product, ".plans"), "oops\n");
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });

  it("fails when .plans links to a directory outside any git repository", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.root, "plain"));
    symlinkSync(join("..", "plain"), join(fixture.product, ".plans"));
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outside any git repository");
  });
});

describe("plans-share sync", () => {
  it("publishes plan files to the remote", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "77");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(join(ticketDir, "A1-spec.md"), "spec\n");
    const result = run(fixture.product, "sync");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Plans synchronized: local changes sent.");
    const remoteFiles = execGit(fixture.remoteUrl, "ls-tree", "-r", "HEAD", "--name-only");
    expect(remoteFiles).toContain("myproj/77/A1-spec.md");
  });

  it("reports nothing to send when already synchronized", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    run(fixture.product, "sync");
    const result = run(fixture.product, "sync");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Plans synchronized: nothing to send.");
  });

  it("sends commits left over from a previously failed push", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    writeFileSync(join(fixture.product, ".plans", "first.md"), "first\n");
    run(fixture.product, "sync");
    const plansClone = join(fixture.root, "team-plans");
    writeFileSync(join(fixture.product, ".plans", "note.md"), "note\n");
    execGit(plansClone, "add", "-A");
    execGit(plansClone, "commit", "--quiet", "-m", "sync");
    const result = run(fixture.product, "sync");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Plans synchronized: local changes sent.");
    const remoteFiles = execGit(fixture.remoteUrl, "ls-tree", "-r", "HEAD", "--name-only");
    expect(remoteFiles).toContain("myproj/note.md");
  });

  it("is a no-op in local plans mode", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = run(fixture.product, "sync");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(local plans mode, nothing to sync)");
  });

  it("fails when .plans is a regular file", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.product, ".plans"), "oops\n");
    const result = run(fixture.product, "sync");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });
});
