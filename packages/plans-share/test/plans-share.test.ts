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
  utimesSync,
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

function addWorktree(fixture: Fixture): string {
  const worktree = join(fixture.root, "product-feat");
  execGit(fixture.product, "worktree", "add", "--quiet", worktree, "-b", "feat");
  return worktree;
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

function age(path: string, days: number): void {
  const timestamp = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, timestamp, timestamp);
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

  it("reports local plans mode when .plans is a plain directory", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = run(fixture.product, "check");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local plans mode");
  });

  it("reports local plans mode identically from a linked worktree", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const worktree = join(fixture.root, "product-feat");
    execGit(fixture.product, "worktree", "add", "--quiet", worktree, "-b", "feat");
    symlinkSync(join("..", "product", ".plans"), join(worktree, ".plans"));
    const result = run(worktree, "check");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local plans mode");
  });

  it("reports shared mode from a linked worktree", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const worktree = join(fixture.root, "product-feat");
    execGit(fixture.product, "worktree", "add", "--quiet", worktree, "-b", "feat");
    symlinkSync(join("..", "product", ".plans"), join(worktree, ".plans"));
    const result = run(worktree, "check");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("team plans repository");
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

  // Local mode is a plain directory, so a symlink out of any repository means the clone moved.
  // It must stay an error.
  it("fails when .plans links to a directory outside any git repository", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.root, "plain"));
    symlinkSync(join("..", "plain"), join(fixture.product, ".plans"));
    const result = run(fixture.product, "check");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outside any git repository");
  });

  it("reports shared mode when .plans links to another repository", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = run(fixture.product, "check");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("team plans repository");
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

  // A linked worktree has its own toplevel. Comparing against it would read this local `.plans`
  // as shared, and sync would commit into the product repository.
  it("is a no-op in local plans mode from a linked worktree", () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const worktree = addWorktree(fixture);
    symlinkSync(join("..", "product", ".plans"), join(worktree, ".plans"));
    const head = execGit(fixture.product, "rev-parse", "HEAD");
    const result = run(worktree, "sync");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(local plans mode, nothing to sync)");
    expect(execGit(fixture.product, "rev-parse", "HEAD")).toBe(head);
  });

  // The worktree owns this .plans, so its toplevel is the worktree itself, never the main one.
  it("is a no-op for a plain .plans belonging to a linked worktree", () => {
    const fixture = makeFixture();
    const worktree = addWorktree(fixture);
    mkdirSync(join(worktree, ".plans"));
    const head = execGit(worktree, "rev-parse", "HEAD");
    const result = run(worktree, "sync");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(local plans mode, nothing to sync)");
    expect(execGit(worktree, "rev-parse", "HEAD")).toBe(head);
  });

  it("fails when .plans is a regular file", () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.product, ".plans"), "oops\n");
    const result = run(fixture.product, "sync");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });

  it("archives stale plans before publishing when requested", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "88");
    const spec = join(ticketDir, "A1-spec.md");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(spec, "spec\n");
    run(fixture.product, "sync");
    age(spec, 10);

    const result = run(fixture.product, "sync", "--auto-archive");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Archived 88 → _archives/88");
    const remoteFiles = execGit(fixture.remoteUrl, "ls-tree", "-r", "HEAD", "--name-only");
    expect(remoteFiles).toContain("myproj/_archives/88/A1-spec.md");
    expect(remoteFiles).not.toContain("myproj/88/A1-spec.md");
  });

  it("rejects unknown options", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = run(fixture.product, "sync", "--bogus");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --bogus");
  });
});

describe("plans-share auto-archive", () => {
  it("rejects arguments without archiving", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "250");
    const spec = join(ticketDir, "A1-spec.md");
    mkdirSync(ticketDir);
    writeFileSync(spec, "spec\n");
    age(spec, 10);

    const result = run(fixture.product, "auto-archive", "--dry-run");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unexpected argument: --dry-run");
    expect(existsSync(ticketDir)).toBe(true);
  });

  it("archives a stale ticket directory and prints the shared-mode publish hint", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const spec = join(fixture.product, ".plans", "250", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "250"));
    writeFileSync(spec, "spec\n");
    age(spec, 10);

    const result = run(fixture.product, "auto-archive");

    expect(result.code).toBe(0);
    expect(existsSync(join(fixture.product, ".plans", "250"))).toBe(false);
    expect(existsSync(join(fixture.product, ".plans", "_archives", "250", "A1-spec.md"))).toBe(
      true,
    );
    expect(result.stdout).toContain("Archived 250 → _archives/250");
    expect(result.stdout).toContain("Publish with: npm run plans:sync");
  });

  it("keeps a fresh ticket directory", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "250");
    mkdirSync(ticketDir);
    writeFileSync(join(ticketDir, "A1-spec.md"), "spec\n");

    const result = run(fixture.product, "auto-archive");

    expect(existsSync(ticketDir)).toBe(true);
    expect(result.stdout).toBe("Nothing to archive.\n");
  });

  it("ignores the archive directory", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const archivedSpec = join(fixture.product, ".plans", "_archives", "old", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "_archives", "old"), { recursive: true });
    writeFileSync(archivedSpec, "spec\n");
    age(archivedSpec, 10);

    const result = run(fixture.product, "auto-archive");

    expect(existsSync(archivedSpec)).toBe(true);
    expect(result.stdout).toBe("Nothing to archive.\n");
  });

  it("archives stale no-ticket sessions and keeps fresh ones", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const sessionDir = join(fixture.product, ".plans", "_alcode");
    const stale = join(sessionDir, "20260101-101010.md");
    const fresh = join(sessionDir, "20260102-101010.md");
    mkdirSync(sessionDir);
    writeFileSync(stale, "stale\n");
    writeFileSync(fresh, "fresh\n");
    age(stale, 10);

    const result = run(fixture.product, "auto-archive");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(
      existsSync(join(fixture.product, ".plans", "_archives", "_alcode", "20260101-101010.md")),
    ).toBe(true);
    expect(result.stdout).toContain(
      "Archived _alcode/20260101-101010.md → _archives/_alcode/20260101-101010.md",
    );
  });

  it("uses the newest nested file as a ticket's age", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "250");
    const oldSpec = join(ticketDir, "A1-spec.md");
    const freshSession = join(ticketDir, "_alcode", "x.md");
    mkdirSync(join(ticketDir, "_alcode"), { recursive: true });
    writeFileSync(oldSpec, "spec\n");
    writeFileSync(freshSession, "session\n");
    age(oldSpec, 30);

    const result = run(fixture.product, "auto-archive");

    expect(existsSync(ticketDir)).toBe(true);
    expect(result.stdout).toBe("Nothing to archive.\n");
  });

  it("honors and validates PLANS_SHARE_ARCHIVE_DAYS", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const ticketDir = join(fixture.product, ".plans", "250");
    const spec = join(ticketDir, "A1-spec.md");
    mkdirSync(ticketDir);
    writeFileSync(spec, "spec\n");
    age(spec, 2);
    const previous = process.env.PLANS_SHARE_ARCHIVE_DAYS;
    try {
      process.env.PLANS_SHARE_ARCHIVE_DAYS = "1";
      expect(run(fixture.product, "auto-archive").code).toBe(0);
      expect(existsSync(join(fixture.product, ".plans", "_archives", "250"))).toBe(true);
      process.env.PLANS_SHARE_ARCHIVE_DAYS = "0";
      const result = run(fixture.product, "auto-archive");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "PLANS_SHARE_ARCHIVE_DAYS must be a positive number of days.",
      );
    } finally {
      if (previous === undefined) delete process.env.PLANS_SHARE_ARCHIVE_DAYS;
      else process.env.PLANS_SHARE_ARCHIVE_DAYS = previous;
    }
  });

  it("suffixes ticket and session file collisions", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const plansDir = join(fixture.product, ".plans");
    const ticketSpec = join(plansDir, "250", "A1-spec.md");
    const session = join(plansDir, "_alcode", "20260101-101010.md");
    mkdirSync(join(plansDir, "250"));
    mkdirSync(join(plansDir, "_archives", "250"), { recursive: true });
    mkdirSync(join(plansDir, "_alcode"));
    mkdirSync(join(plansDir, "_archives", "_alcode"));
    writeFileSync(ticketSpec, "new spec\n");
    writeFileSync(join(plansDir, "_archives", "250", "A1-spec.md"), "old spec\n");
    writeFileSync(session, "new session\n");
    writeFileSync(join(plansDir, "_archives", "_alcode", "20260101-101010.md"), "old session\n");
    age(ticketSpec, 10);
    age(session, 10);

    const result = run(fixture.product, "auto-archive");

    expect(existsSync(join(plansDir, "_archives", "250-2", "A1-spec.md"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "_alcode", "20260101-101010-2.md"))).toBe(true);
    expect(result.stdout).toContain("Archived 250 → _archives/250-2");
    expect(result.stdout).toContain(
      "Archived _alcode/20260101-101010.md → _archives/_alcode/20260101-101010-2.md",
    );
  });

  it("works in local mode without a publish hint", () => {
    const fixture = makeFixture();
    const plansDir = join(fixture.product, ".plans");
    const spec = join(plansDir, "250", "A1-spec.md");
    mkdirSync(join(plansDir, "250"), { recursive: true });
    writeFileSync(spec, "spec\n");
    age(spec, 10);

    const result = run(fixture.product, "auto-archive");

    expect(result.code).toBe(0);
    expect(existsSync(join(plansDir, "_archives", "250", "A1-spec.md"))).toBe(true);
    expect(result.stdout).not.toContain("Publish with:");
  });
});

describe("plans-share archive", () => {
  it("accepts a ticket id and a path", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const plansDir = join(fixture.product, ".plans");
    mkdirSync(join(plansDir, "101"));
    mkdirSync(join(plansDir, "102"));

    const idResult = run(fixture.product, "archive", "101");
    const pathResult = run(fixture.product, "archive", ".plans/102");

    expect(idResult.code).toBe(0);
    expect(pathResult.code).toBe(0);
    expect(existsSync(join(plansDir, "_archives", "101"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "102"))).toBe(true);
  });

  it("rejects a missing directory", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = run(fixture.product, "archive", "missing");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing must be an existing directory directly under .plans");
  });

  it("rejects an underscore-prefixed name", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    mkdirSync(join(fixture.product, ".plans", "_private"));
    const result = run(fixture.product, "archive", "_private");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("names starting with _ are not tickets");
  });

  it("rejects a missing argument", () => {
    const fixture = makeFixture();
    runSetup(fixture);
    const result = run(fixture.product, "archive");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: plans-share archive <ticket-id | path>");
  });
});
