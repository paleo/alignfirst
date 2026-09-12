import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findStoppedRebase } from "../src/plans/rebase.js";
import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plans commands", () => {
  it("reports local plans mode", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = await runMain(["plans", "check"], { cwd: fixture.product });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("local plans mode");
  });

  it("sets up the plans link with the configured folder", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "product-plans" } }),
    );
    const result = await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product });
    expect(result.code).toBe(0);
    expect(lstatSync(join(fixture.product, ".plans")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(
      join("..", "team-plans", "product-plans"),
    );
    expect(result.stdout).toContain("Publish with: alignfirst sync");
  });

  it("accepts --folder when it matches plans.folder", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "product-plans" } }),
    );
    expect(
      (
        await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
          cwd: fixture.product,
        })
      ).code,
    ).toBe(0);
  });

  it("keeps the plans folder inside the clone", async () => {
    const fixture = makeFixture();
    const traversal = await runMain(["plans", "setup", fixture.clone, "--folder", "../escaped"], {
      cwd: fixture.product,
    });
    expect(traversal.code).toBe(1);
    expect(traversal.stderr).toContain("must be a single path segment");
    expect(existsSync(join(fixture.root, "escaped"))).toBe(false);

    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.clone, "escaped-link"), "dir");
    const symlink = await runMain(["plans", "setup", fixture.clone, "--folder", "escaped-link"], {
      cwd: fixture.product,
    });
    expect(symlink.code).toBe(1);
    expect(symlink.stderr).toContain("must resolve inside");
    expect(existsSync(join(fixture.product, ".plans"))).toBe(false);
  });

  it("rejects reserved plans folders before migrating local plans", async () => {
    const fixture = makeFixture();
    const localPlan = join(fixture.product, ".plans", "78", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "78"), { recursive: true });
    writeFileSync(localPlan, "spec\n");

    for (const folder of [".git", "_archives"]) {
      const result = await runMain(["plans", "setup", fixture.clone, "--folder", folder], {
        cwd: fixture.product,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Plans folder "${folder}" is reserved.`);
    }

    expect(readFileSync(localPlan, "utf8")).toBe("spec\n");
    expect(lstatSync(join(fixture.product, ".plans")).isDirectory()).toBe(true);
  });

  it("synchronizes shared plans", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    mkdirSync(join(fixture.product, ".plans", "78"));
    writeFileSync(join(fixture.product, ".plans", "78", "A1-spec.md"), "spec\n");
    const result = await runMain(["sync"], { cwd: fixture.product });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local changes sent");
    expect(git(join(fixture.root, "remote.git"), "ls-tree", "-r", "HEAD", "--name-only")).toContain(
      "product-plans/78/A1-spec.md",
    );
  });

  it("resolves a content conflict by keeping the local version", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    const plan = join(fixture.product, ".plans", "78", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "78"));
    writeFileSync(plan, "first\n");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);

    const other = join(fixture.root, "other-plans");
    git(fixture.root, "clone", "--quiet", join(fixture.root, "remote.git"), other);
    writeFileSync(join(other, "product-plans", "78", "A1-spec.md"), "remote\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "remote");
    git(other, "push", "--quiet");

    writeFileSync(plan, "local\n");
    const conflict = await runMain(["sync"], { cwd: fixture.product });
    expect(conflict.code).toBe(0);
    expect(conflict.stdout).toContain(
      "Resolved product-plans/78/A1-spec.md: kept the local version.",
    );
    expect(readFileSync(plan, "utf8")).toBe("local\n");
    expect(git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/78/A1-spec.md")).toBe(
      "local",
    );
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  });

  it("resolves conflicts in successive local commits", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    const ticketDir = join(fixture.product, ".plans", "78");
    const planA = join(ticketDir, "A1-spec.md");
    const planB = join(ticketDir, "B1-plan.md");
    mkdirSync(ticketDir);
    writeFileSync(planA, "first A\n");
    writeFileSync(planB, "first B\n");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);

    const other = join(fixture.root, "other-plans");
    git(fixture.root, "clone", "--quiet", join(fixture.root, "remote.git"), other);
    writeFileSync(join(other, "product-plans", "78", "A1-spec.md"), "remote A\n");
    writeFileSync(join(other, "product-plans", "78", "B1-plan.md"), "remote B\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "remote");
    git(other, "push", "--quiet");

    writeFileSync(planA, "local A\n");
    git(fixture.clone, "add", "product-plans/78/A1-spec.md");
    git(fixture.clone, "commit", "--quiet", "-m", "local A");
    writeFileSync(planB, "local B\n");
    git(fixture.clone, "add", "product-plans/78/B1-plan.md");
    git(fixture.clone, "commit", "--quiet", "-m", "local B");

    const result = await runMain(["sync"], { cwd: fixture.product });

    expect(result.code).toBe(0);
    expect(readFileSync(planA, "utf8")).toBe("local A\n");
    expect(readFileSync(planB, "utf8")).toBe("local B\n");
    const remote = join(fixture.root, "remote.git");
    expect(git(remote, "show", "HEAD:product-plans/78/A1-spec.md")).toBe("local A");
    expect(git(remote, "show", "HEAD:product-plans/78/B1-plan.md")).toBe("local B");
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  });

  it("keeps both paths on a rename conflict", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    const plan = join(fixture.product, ".plans", "78", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "78"));
    writeFileSync(plan, "first\n");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);

    const other = join(fixture.root, "other-plans");
    git(fixture.root, "clone", "--quiet", join(fixture.root, "remote.git"), other);
    mkdirSync(join(other, "product-plans", "_archives", "78"), { recursive: true });
    git(other, "mv", "product-plans/78/A1-spec.md", "product-plans/_archives/78/A1-spec.md");
    git(other, "commit", "--quiet", "-m", "archive");
    git(other, "push", "--quiet");

    writeFileSync(plan, "local\n");
    git(fixture.clone, "config", "merge.renames", "false");
    const conflict = await runMain(["sync"], { cwd: fixture.product });
    expect(conflict.code).toBe(0);
    expect(conflict.stdout).toContain(
      "Resolved product-plans/78/A1-spec.md: kept the paths present in the working tree.",
    );
    expect(git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/78/A1-spec.md")).toBe(
      "local",
    );
    expect(
      git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/_archives/78/A1-spec.md"),
    ).toBe("first");
  });

  it("leaves a rebase it did not start alone", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    const plan = join(fixture.product, ".plans", "78", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "78"));
    writeFileSync(plan, "first\n");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);

    const other = join(fixture.root, "other-plans");
    git(fixture.root, "clone", "--quiet", join(fixture.root, "remote.git"), other);
    writeFileSync(join(other, "product-plans", "78", "A1-spec.md"), "remote\n");
    git(other, "add", "-A");
    git(other, "commit", "--quiet", "-m", "remote");
    git(other, "push", "--quiet");

    writeFileSync(plan, "local\n");
    git(fixture.clone, "add", "-A");
    git(fixture.clone, "commit", "--quiet", "-m", "local");
    expect(() => git(fixture.clone, "pull", "--rebase")).toThrow();

    const conflict = await runMain(["sync"], { cwd: fixture.product });
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("Plans synchronization stopped on a conflict");
    expect((await runMain(["plans", "check"], { cwd: fixture.product })).code).toBe(1);
    expect(
      (
        await runMain(["doctor"], {
          cwd: fixture.product,
          env: { PATH: "" },
          home: fixture.root,
        })
      ).stdout,
    ).toContain("[error] Plans: rebase stopped on a conflict in");

    writeFileSync(plan, "resolved\n");
    git(fixture.clone, "add", "-A");
    git(fixture.clone, "-c", "core.editor=true", "rebase", "--continue");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);
  });

  it("rejects conflicting, absent and missing-clone setup inputs", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "configured" } }),
    );
    expect(
      (
        await runMain(["plans", "setup", fixture.clone, "--folder", "argument"], {
          cwd: fixture.product,
        })
      ).stderr,
    ).toContain('--folder "argument" differs from plans.folder "configured"');
    rmSync(join(fixture.product, ".alignfirst.json"));
    expect(
      (await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product })).stderr,
    ).toContain("Pass --folder");
    expect(
      (
        await runMain(["plans", "setup", join(fixture.root, "missing"), "--folder", "p"], {
          cwd: fixture.product,
        })
      ).stderr,
    ).toContain("does not exist");
  });

  it("archives a ticket and honors ALIGNFIRST_ARCHIVE_DAYS", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans", "78"), { recursive: true });
    const archive = await runMain(["plans", "archive", "78"], { cwd: fixture.product });
    expect(archive.code).toBe(0);
    expect(existsSync(join(fixture.product, ".plans", "_archives", "78"))).toBe(true);
    const stale = join(fixture.product, ".plans", "79");
    mkdirSync(stale);
    const date = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, date, date);
    const automatic = await runMain(["plans", "auto-archive"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });
    expect(automatic.stdout).toContain("Archived 79");
  });

  it("keeps fresh running sessions while archiving stale completed sessions", async () => {
    const fixture = makeFixture();
    const plansDir = join(fixture.product, ".plans");
    const sessionDir = join(plansDir, "_alcode");
    const ticketSessionDir = join(plansDir, "79", "_alcode");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(ticketSessionDir, { recursive: true });
    const running = join(sessionDir, "20260901-100000.md");
    const succeeded = join(sessionDir, "20260901-110000.md");
    const ticketSession = join(ticketSessionDir, "20260901-120000.md");
    writeFileSync(running, "---\nstatus: running\n---\n");
    writeFileSync(succeeded, "---\nstatus: succeeded\n---\n");
    writeFileSync(ticketSession, "---\nstatus: running\n---\n");
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(succeeded, old, old);

    const result = await runMain(["plans", "auto-archive"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });

    expect(result.stdout).toContain("Archived _alcode/20260901-110000.md");
    expect(existsSync(running)).toBe(true);
    expect(existsSync(succeeded)).toBe(false);
    expect(existsSync(join(plansDir, "_archives", "_alcode", "20260901-110000.md"))).toBe(true);
    expect(existsSync(join(plansDir, "79"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "79"))).toBe(false);
  });

  it("archives stale running sessions and their ticket directories", async () => {
    const fixture = makeFixture();
    const plansDir = join(fixture.product, ".plans");
    const running = join(plansDir, "_alcode", "20260901-100000.md");
    const ticketSession = join(plansDir, "79", "_alcode", "20260901-120000.md");
    mkdirSync(join(plansDir, "_alcode"), { recursive: true });
    mkdirSync(join(plansDir, "79", "_alcode"), { recursive: true });
    writeFileSync(running, "---\nstatus: running\n---\n");
    writeFileSync(ticketSession, "---\nstatus: running\n---\n");
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(running, old, old);
    utimesSync(ticketSession, old, old);

    const result = await runMain(["plans", "auto-archive"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Archived _alcode/20260901-100000.md");
    expect(result.stdout).toContain("Archived 79");
    expect(existsSync(running)).toBe(false);
    expect(existsSync(ticketSession)).toBe(false);
    expect(existsSync(join(plansDir, "_archives", "_alcode", "20260901-100000.md"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "79", "_alcode", "20260901-120000.md"))).toBe(
      true,
    );
  });

  it("archives a ticket given through the plans clone path", async () => {
    const fixture = makeFixture();
    await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
    });
    mkdirSync(join(fixture.clone, "product-plans", "78"));
    const result = await runMain(["plans", "archive", join(fixture.clone, "product-plans", "78")], {
      cwd: fixture.product,
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Archived 78 → _archives/78");
    expect(existsSync(join(fixture.clone, "product-plans", "_archives", "78"))).toBe(true);
    expect(existsSync(join(fixture.clone, "product-plans", "78"))).toBe(false);
    expect(readdirSync(fixture.product).toSorted()).toEqual([".git", ".plans", "README.md"]);
  });

  it("uses plans.autoArchive and honors --no-auto-archive", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, ".alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        plans: { folder: "product-plans", autoArchive: true },
      }),
    );
    await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product });
    const old = new Date(Date.now() - 2 * 86_400_000);
    const staleFile = join(fixture.product, ".plans", "79", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "79"));
    writeFileSync(staleFile, "stale\n");
    utimesSync(staleFile, old, old);
    const archived = await runMain(["sync"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });
    expect(archived.stdout).toContain("Archived 79");
    expect(git(join(fixture.root, "remote.git"), "ls-tree", "-r", "HEAD", "--name-only")).toContain(
      "product-plans/_archives/79/A1-spec.md",
    );

    const keptFile = join(fixture.product, ".plans", "80", "A1-spec.md");
    mkdirSync(join(fixture.product, ".plans", "80"));
    writeFileSync(keptFile, "kept\n");
    utimesSync(keptFile, old, old);
    const kept = await runMain(["sync", "--no-auto-archive"], {
      cwd: fixture.product,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });
    expect(kept.stdout).not.toContain("Archived 80");
    expect(existsSync(join(fixture.product, ".plans", "80"))).toBe(true);
  });

  it("rejects mutually exclusive synchronization options", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = await runMain(["sync", "--auto-archive", "--no-auto-archive"], {
      cwd: fixture.product,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });
});

interface Fixture {
  root: string;
  product: string;
  clone: string;
}

function makeFixture(): Fixture {
  const root = makeTempDir("alignfirst-plans-");
  dirs.push(root);
  configureGit(root);
  const remote = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", remote);
  const clone = join(root, "team-plans");
  git(root, "clone", "--quiet", remote, clone);
  const product = join(root, "product");
  git(root, "init", "--quiet", product);
  writeFileSync(join(product, "README.md"), "product\n");
  git(product, "add", "-A");
  git(product, "commit", "--quiet", "-m", "init");
  return { root, product, clone };
}
