import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findStoppedRebase } from "../src/plans/rebase.js";
import { configureGit, git, makeTempDir, runMain, writeRegistry } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plans commands", () => {
  it("archives and restores profile-only work files with sessions in the project tree", async () => {
    const { root, product } = makeFixture();
    writeRegistry(root, { projects: { "~/product": { aligndev: { profile: "work" } } } });
    const ticket = join(product, ".plans", "78");
    mkdirSync(join(ticket, "_aligndev"), { recursive: true });
    writeFileSync(join(ticket, "_aligndev", "run.md"), "run\n");
    const archived = await runMain(["plans", "archive", "78"], { cwd: product, home: root });
    expect(archived.code).toBe(0);
    expect(existsSync(join(product, ".plans", "_archives", "78", "_aligndev", "run.md"))).toBe(
      true,
    );
    const restored = await runMain(["ticket", "78", "--json"], { cwd: product, home: root });
    expect(restored.code).toBe(0);
    expect(existsSync(join(ticket, "_aligndev", "run.md"))).toBe(true);
    expect(readdirSync(join(root, ".alignfirst", "companions"))).toEqual(["registry.json"]);
  });
  it("reports local mode", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const result = await runMain(["plans", "check"], { cwd: fixture.product });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("local mode");
  });

  it("sets up the plans link with the configured folder", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { repositoryFolder: "product-plans" } }),
    );
    const result = await runMain(["plans", "setup", fixture.clone], { cwd: fixture.product });
    expect(result.code).toBe(0);
    expect(lstatSync(join(fixture.product, ".plans")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(
      join("..", "team-plans", "product-plans"),
    );
    expect(result.stdout).toContain("Publish with: alignfirst sync");
  });

  it("accepts --folder when it matches plans.repositoryFolder", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { repositoryFolder: "product-plans" } }),
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
      expect(result.stderr).toContain(`Project folder "${folder}" is reserved.`);
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

  it("resolves a content conflict by preserving both versions", async () => {
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
    expect(conflict.stdout).toContain("saved the local version as product-plans/78/A2-spec.md.");
    expect(readFileSync(plan, "utf8")).toBe("remote\n");
    expect(readFileSync(join(plan, "..", "A2-spec.md"), "utf8")).toBe("local\n");
    expect(git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/78/A1-spec.md")).toBe(
      "remote",
    );
    expect(git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/78/A2-spec.md")).toBe(
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
    expect(readFileSync(planA, "utf8")).toBe("remote A\n");
    expect(readFileSync(planB, "utf8")).toBe("remote B\n");
    const remote = join(fixture.root, "remote.git");
    expect(git(remote, "show", "HEAD:product-plans/78/A1-spec.md")).toBe("remote A");
    expect(git(remote, "show", "HEAD:product-plans/78/B1-plan.md")).toBe("remote B");
    expect(git(remote, "show", "HEAD:product-plans/78/B2-spec.md")).toBe("local A");
    expect(git(remote, "show", "HEAD:product-plans/78/B3-plan.md")).toBe("local B");
    expect(findStoppedRebase(fixture.clone)).toBeUndefined();
  });

  it("keeps both paths on an archive versus edit conflict that git sees as no rename", async () => {
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
    // The rewrite hides the rename from every git version; git 2.39 ignores `merge.renames=false`
    // in a rebase.
    writeFileSync(join(other, "product-plans", "_archives", "78", "A1-spec.md"), "archived\n");
    git(other, "commit", "--quiet", "-am", "archive");
    git(other, "push", "--quiet");

    writeFileSync(plan, "local\n");
    const conflict = await runMain(["sync"], { cwd: fixture.product });
    expect(conflict.code).toBe(0);
    expect(conflict.stdout).toContain(
      "Resolved product-plans/78/A1-spec.md: preserved committed contents at the surviving paths.",
    );
    expect(git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/78/A1-spec.md")).toBe(
      "local",
    );
    expect(
      git(join(fixture.root, "remote.git"), "show", "HEAD:product-plans/_archives/78/A1-spec.md"),
    ).toBe("archived");
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
    expect(conflict.stderr).toContain("Work-files synchronization stopped on a conflict");
    for (const args of [
      ["plans", "check"],
      ["plans", "check", "--json"],
    ]) {
      const check = await runMain(args, { cwd: fixture.product });
      expect(check.code).toBe(1);
      expect(check.stdout).toBe("");
      expect(check.stderr).toContain("Work-files synchronization stopped on a conflict");
    }
    const doctor = await runMain(["doctor"], {
      cwd: fixture.product,
      env: { PATH: "" },
      home: fixture.root,
    });
    expect(doctor.stdout).toContain("[error] Work files: rebase stopped on a conflict in");
    expect(doctor.stdout).toContain(
      `git -C ${fixture.clone} add -A && git -C ${fixture.clone} rebase --continue`,
    );
    expect(doctor.stdout).toContain(
      `keeping the local commits: git -C ${fixture.clone} rebase --abort`,
    );
    expect(conflict.stderr).toContain("To abandon the rebase");
    expect(findStoppedRebase(fixture.clone)).toBeDefined();

    writeFileSync(plan, "resolved\n");
    git(fixture.clone, "add", "-A");
    git(fixture.clone, "-c", "core.editor=true", "rebase", "--continue");
    expect((await runMain(["sync"], { cwd: fixture.product })).code).toBe(0);
  });

  it("rejects conflicting, absent and missing-clone setup inputs", async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.product, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { repositoryFolder: "configured" } }),
    );
    expect(
      (
        await runMain(["plans", "setup", fixture.clone, "--folder", "argument"], {
          cwd: fixture.product,
        })
      ).stderr,
    ).toContain('--folder "argument" differs from plans.repositoryFolder "configured"');
    rmSync(join(fixture.product, "alignfirst.json"));
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
    const sessionDir = join(plansDir, "_aligndev");
    const ticketSessionDir = join(plansDir, "79", "_aligndev");
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

    expect(result.stdout).toContain("Archived _aligndev/20260901-110000.md");
    expect(existsSync(running)).toBe(true);
    expect(existsSync(succeeded)).toBe(false);
    expect(existsSync(join(plansDir, "_archives", "_aligndev", "20260901-110000.md"))).toBe(true);
    expect(existsSync(join(plansDir, "79"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "79"))).toBe(false);
  });

  it("archives stale running sessions and their ticket directories", async () => {
    const fixture = makeFixture();
    const plansDir = join(fixture.product, ".plans");
    const running = join(plansDir, "_aligndev", "20260901-100000.md");
    const ticketSession = join(plansDir, "79", "_aligndev", "20260901-120000.md");
    mkdirSync(join(plansDir, "_aligndev"), { recursive: true });
    mkdirSync(join(plansDir, "79", "_aligndev"), { recursive: true });
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
    expect(result.stdout).toContain("Archived _aligndev/20260901-100000.md");
    expect(result.stdout).toContain("Archived 79");
    expect(existsSync(running)).toBe(false);
    expect(existsSync(ticketSession)).toBe(false);
    expect(existsSync(join(plansDir, "_archives", "_aligndev", "20260901-100000.md"))).toBe(true);
    expect(existsSync(join(plansDir, "_archives", "79", "_aligndev", "20260901-120000.md"))).toBe(
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
      join(fixture.product, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        plans: { repositoryFolder: "product-plans", autoArchive: true },
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

describe("plans check contract", () => {
  it.each([["--help"], ["check", "--help"], ["check", "-h"]])(
    "documents check --json in %j without requiring plans",
    async (...args) => {
      const fixture = makeFixture();
      const result = await runMain(["plans", ...args], { cwd: fixture.product });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("alignfirst plans check [--json]");
    },
  );

  it.each([["extra"], ["--root", "x"], ["--unknown"], ["--json", "extra"]])(
    "rejects check arguments %j without a success document",
    async (...args) => {
      const fixture = makeFixture();
      mkdirSync(join(fixture.product, ".plans"));
      const result = await runMain(["plans", "check", ...args], { cwd: fixture.product });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: alignfirst plans check [--json]");
    },
  );

  it("reports exact local JSON and preserves the legacy text", async () => {
    const fixture = makeFixture();
    const plans = join(fixture.product, ".plans");
    mkdirSync(plans);
    const options = { cwd: fixture.product, home: fixture.root };
    const result = await runMain(["plans", "check", "--json"], options);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "local",
      plans: { in: "project", path: plans, target: realpathSync(plans) },
      mainWorktree: null,
    });
    expect(await runMain(["plans", "check"], options)).toEqual({
      code: 0,
      stdout: ".plans is a local directory (local mode): synchronization is disabled.\n",
      stderr: "",
    });
  });

  it("accepts a separate repository tracking its own work files through an alias chain", async () => {
    const fixture = makeFixture();
    const target = join(fixture.clone, "product-plans");
    mkdirSync(target);
    writeFileSync(join(target, "note.md"), "shared\n");
    git(fixture.clone, "add", "product-plans");
    git(fixture.clone, "commit", "--quiet", "-m", "work files");
    const alias = join(fixture.root, "work-files-alias");
    symlinkSync(target, alias);
    const plans = join(fixture.product, ".plans");
    symlinkSync(alias, plans);
    const options = { cwd: fixture.product, home: fixture.root };
    const result = await runMain(["plans", "check", "--json"], options);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "shared",
      plans: { in: "project", path: plans, target: realpathSync(target) },
      mainWorktree: null,
    });
    expect(await runMain(["plans", "check"], options)).toEqual({
      code: 0,
      stdout: ".plans is linked to the work-files repository.\n",
      stderr: "",
    });
  });

  it.each(["local", "shared"])(
    "reports effective companion plans in %s mode despite an unused tracked project copy",
    async (mode) => {
      const fixture = makeFixture();
      const unused = join(fixture.product, ".plans");
      mkdirSync(unused);
      writeFileSync(join(unused, "tracked.md"), "unused\n");
      git(fixture.product, "add", ".plans");
      git(fixture.product, "commit", "--quiet", "-m", "unused plans");
      const plans = join(useCompanion(fixture), ".plans");
      mkdirSync(join(plans, ".."), { recursive: true });
      const target = mode === "local" ? plans : join(fixture.clone, "product-plans");
      mkdirSync(target);
      if (mode === "shared") symlinkSync(target, plans);
      const before = snapshotTree(unused);
      const registry = join(fixture.root, ".alignfirst", "companions", "registry.json");
      const registryBefore = readFileSync(registry);
      const result = await runMain(["plans", "check", "--json"], {
        cwd: fixture.product,
        home: fixture.root,
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        mode,
        plans: { in: "companion", path: plans, target: realpathSync(target) },
        mainWorktree: null,
      });
      expect(snapshotTree(unused)).toEqual(before);
      expect(readFileSync(registry)).toEqual(registryBefore);
    },
  );

  it("accepts a real local directory outside Git", async () => {
    const fixture = makeFixture();
    const cwd = join(fixture.root, "plain");
    const plans = join(cwd, ".plans");
    mkdirSync(plans, { recursive: true });
    const result = await runMain(["plans", "check", "--json"], { cwd, home: fixture.root });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "local",
      plans: { in: "project", path: plans, target: realpathSync(plans) },
      mainWorktree: null,
    });
  });

  it("classifies a link into a work-files clone as shared from a project outside Git", async () => {
    const fixture = makeFixture();
    const cwd = join(fixture.root, "plain");
    mkdirSync(cwd);
    const folder = join(fixture.clone, "plain-plans");
    mkdirSync(folder);
    const plans = join(cwd, ".plans");
    symlinkSync(folder, plans);
    const result = await runMain(["plans", "check", "--json"], { cwd, home: fixture.root });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "shared",
      plans: { in: "project", path: plans, target: realpathSync(folder) },
      mainWorktree: null,
    });
  });

  it.each(["missing", "broken", "file", "outsideGit"])(
    "preserves the %s refusal without partial JSON",
    async (kind) => {
      const fixture = makeFixture();
      const plans = join(fixture.product, ".plans");
      if (kind === "broken") symlinkSync(join(fixture.root, "missing"), plans);
      if (kind === "file") writeFileSync(plans, "not a directory\n");
      if (kind === "outsideGit") {
        const target = join(fixture.root, "plain");
        mkdirSync(target);
        symlinkSync(target, plans);
      }
      const messages: Record<string, string> = {
        missing: "No .plans/ directory",
        broken: "The .plans symlink is broken.",
        file: ".plans is not a directory.",
        outsideGit: ".plans points outside any git repository.",
      };
      const result = await runMain(["plans", "check", "--json"], {
        cwd: fixture.product,
        home: fixture.root,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(messages[kind]);
    },
  );
});

describe("project-tracked plans gate", () => {
  it.each(["tracked", "staged", "mixed", "trackedLink", "alias", "linkedAlias"])(
    "refuses %s effective plans without touching their index or contents",
    async (kind) => {
      const fixture = makeFixture();
      const plans = join(fixture.product, ".plans");
      let source = plans;
      if (kind === "alias" || kind === "linkedAlias") {
        let sourceRepo = fixture.product;
        if (kind === "linkedAlias") {
          sourceRepo = join(fixture.root, "other-worktree");
          git(fixture.product, "worktree", "add", "--quiet", "-b", "other", sourceRepo);
        }
        source = join(sourceRepo, "tracked-plans");
        mkdirSync(source);
        writeFileSync(join(source, "note.md"), "tracked\n");
        git(sourceRepo, "add", "tracked-plans");
        git(sourceRepo, "commit", "--quiet", "-m", "track target");
        symlinkSync(source, plans);
      } else if (kind === "trackedLink") {
        source = join(fixture.clone, "source");
        mkdirSync(source);
        symlinkSync(source, plans);
        git(fixture.product, "add", ".plans");
        git(fixture.product, "commit", "--quiet", "-m", "track link");
      } else {
        mkdirSync(plans);
        writeFileSync(join(plans, "tracked.md"), "tracked\n");
        git(fixture.product, "add", ".plans");
        if (kind !== "staged") git(fixture.product, "commit", "--quiet", "-m", "track plans");
        if (kind === "mixed") writeFileSync(join(plans, "untracked.md"), "untracked\n");
      }
      const index = readFileSync(join(fixture.product, ".git", "index"));
      const sourceIndexPath = git(
        source,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      );
      const sourceIndex = existsSync(sourceIndexPath) ? readFileSync(sourceIndexPath) : undefined;
      const before = snapshotTree(fixture.product);
      const sourceBefore = snapshotTree(source);
      const result = await runMain(["plans", "check", "--json"], {
        cwd: fixture.product,
        home: fixture.root,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expectTrackingRemedies(
        result.stderr,
        kind === "alias" || kind === "linkedAlias" ? source : plans,
      );
      expect(snapshotTree(fixture.product)).toEqual(before);
      expect(snapshotTree(source)).toEqual(sourceBefore);
      expect(readFileSync(join(fixture.product, ".git", "index"))).toEqual(index);
      expect(existsSync(sourceIndexPath) ? readFileSync(sourceIndexPath) : undefined).toEqual(
        sourceIndex,
      );
    },
  );

  it("refuses a tracked symlink through an aliased checkout path", async () => {
    const fixture = makeFixture();
    symlinkSync(fixture.clone, join(fixture.product, ".plans"));
    git(fixture.product, "add", ".plans");
    git(fixture.product, "commit", "--quiet", "-m", "track link");
    const alias = join(fixture.root, "aliased-checkout");
    symlinkSync(fixture.product, alias);
    const before = snapshotTree(fixture.clone);
    const result = await runMain(["plans", "check", "--json"], {
      cwd: alias,
      home: fixture.root,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tracked by this project's repository");
    expect(snapshotTree(fixture.clone)).toEqual(before);
  });

  it.each([false, true])(
    "uses literal paths when companion plans are tracked: %s",
    async (tracked) => {
      const fixture = makeFixture();
      const companion = join(fixture.product, "plans[1]");
      const plans = join(companion, ".plans");
      mkdirSync(plans, { recursive: true });
      writeFileSync(join(plans, "note.md"), "effective\n");
      const unrelated = join(fixture.product, "plans1", ".plans");
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(join(unrelated, "note.md"), "unrelated\n");
      git(
        fixture.product,
        "--literal-pathspecs",
        "add",
        "plans1",
        ...(tracked ? ["plans[1]"] : []),
      );
      writeRegistry(fixture.root, {
        projects: { [fixture.product]: { dir: companion, items: { ".plans": "companion" } } },
      });
      const result = await runMain(["plans", "check", "--json"], {
        cwd: fixture.product,
        home: fixture.root,
      });
      expect(result.code, result.stderr).toBe(tracked ? 1 : 0);
      if (tracked) {
        expect(result.stdout).toBe("");
        expectTrackingRemedies(result.stderr, plans);
      } else {
        expect(JSON.parse(result.stdout)).toEqual({
          mode: "local",
          plans: { in: "companion", path: plans, target: realpathSync(plans) },
          mainWorktree: null,
        });
      }
    },
  );

  it("propagates index-query failures instead of declaring plans untracked", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.product, ".plans"));
    const index = join(fixture.product, ".git", "index");
    writeFileSync(index, "corrupt index\n");
    const result = await runMain(["plans", "check", "--json"], {
      cwd: fixture.product,
      home: fixture.root,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(readFileSync(index, "utf8")).toBe("corrupt index\n");
  });

  it.each([
    ["plans", "check", "--json"],
    ["sync", "--auto-archive"],
  ])("refuses Git ownership errors before work-file effects: %j", async (...args) => {
    const fixture = makeFixture();
    const ticket = join(fixture.product, ".plans", "78");
    mkdirSync(ticket, { recursive: true });
    const request = join(ticket, "A1-request.md");
    writeFileSync(request, "tracked request\n");
    const stale = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(request, stale, stale);
    git(fixture.product, "add", ".plans");
    git(fixture.product, "commit", "--quiet", "-m", "track request");
    const before = snapshotTree(fixture.product);
    const index = join(fixture.product, ".git", "index");
    const indexBefore = readFileSync(index);
    vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");

    const result = await runMain(args, { cwd: fixture.product, home: fixture.root });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dubious ownership");
    expect(snapshotTree(fixture.product)).toEqual(before);
    expect(readFileSync(index)).toEqual(indexBefore);
  });
});

describe("linked-worktree plans parity", () => {
  it.each(["local", "shared", "companion", "sharedCompanion"])(
    "reports %s plans shared through the main worktree",
    async (kind) => {
      const fixture = makeFixture();
      const companion = kind === "companion" || kind === "sharedCompanion";
      const shared = kind === "shared" || kind === "sharedCompanion";
      const mainPlans = join(companion ? useCompanion(fixture) : fixture.product, ".plans");
      mkdirSync(join(mainPlans, ".."), { recursive: true });
      const target = shared ? join(fixture.clone, "product-plans") : mainPlans;
      mkdirSync(target);
      if (shared) symlinkSync(target, mainPlans);
      const worktree = join(fixture.root, "ticket-worktree");
      git(fixture.product, "worktree", "add", "--quiet", "-b", "ticket", worktree);
      const plans = companion ? mainPlans : join(worktree, ".plans");
      if (!companion) symlinkSync(mainPlans, plans);
      const result = await runMain(["plans", "check", "--json"], {
        cwd: worktree,
        home: fixture.root,
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        mode: shared ? "shared" : "local",
        plans: {
          in: companion ? "companion" : "project",
          path: plans,
          target: realpathSync(target),
        },
        mainWorktree: realpathSync(fixture.product),
      });
    },
  );

  it("does not mistake main-worktree subdirectories or checkout aliases for linked roots", async () => {
    const fixture = makeFixture();
    const subdir = join(fixture.product, "subdir");
    mkdirSync(join(subdir, ".plans"), { recursive: true });
    mkdirSync(join(fixture.product, ".plans"));
    const alias = join(fixture.root, "checkout-alias");
    symlinkSync(fixture.product, alias);
    for (const cwd of [subdir, alias]) {
      const result = await runMain(["plans", "check", "--json"], { cwd, home: fixture.root });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        mode: "local",
        plans: {
          in: "project",
          path: join(fixture.product, ".plans"),
          target: realpathSync(join(fixture.product, ".plans")),
        },
        mainWorktree: null,
      });
    }
  });

  it.each(["missing", "broken", "file"])(
    "validates %s main plans before resolving the main target",
    async (kind) => {
      const fixture = makeFixture();
      const mainPlans = join(fixture.product, ".plans");
      if (kind === "broken") symlinkSync(join(fixture.root, "missing"), mainPlans);
      if (kind === "file") writeFileSync(mainPlans, "not a directory\n");
      const worktree = join(fixture.root, "ticket-worktree");
      git(fixture.product, "worktree", "add", "--quiet", "-b", "ticket", worktree);
      mkdirSync(join(worktree, ".plans"));
      const result = await runMain(["plans", "check", "--json"], {
        cwd: worktree,
        home: fixture.root,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        kind === "missing"
          ? "No .plans/ directory"
          : kind === "broken"
            ? "symlink is broken"
            : "not a directory",
      );
      expect(result.stderr).not.toContain("ENOENT");
    },
  );
});

describe("plans refusals before command side effects", () => {
  it.each(["tracked", "differentTarget"])(
    "blocks check, ticket reservation/restoration and sync for %s plans",
    async (kind) => {
      const fixture = makeFixture();
      const mainPlans = join(fixture.product, ".plans");
      mkdirSync(mainPlans);
      let cwd = fixture.product;
      if (kind === "differentTarget") {
        cwd = join(fixture.root, "ticket-worktree");
        git(fixture.product, "worktree", "add", "--quiet", "-b", "ticket", cwd);
      }
      const plans = join(cwd, ".plans");
      mkdirSync(join(plans, "78"), { recursive: true });
      mkdirSync(join(plans, "_archives", "79"), { recursive: true });
      const active = join(plans, "78", "A1-spec.md");
      writeFileSync(active, "active\n");
      writeFileSync(join(plans, "_archives", "79", "A1-spec.md"), "archived\n");
      const old = new Date(Date.now() - 2 * 86_400_000);
      utimesSync(active, old, old);
      if (kind === "tracked") git(cwd, "add", ".plans");
      const before = snapshotTree(cwd);
      const mainBefore = snapshotTree(mainPlans);
      const indexPath = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
      const indexBefore = readFileSync(indexPath);
      for (const args of [
        ["plans", "check", "--json"],
        ["ticket", "--side", "--json"],
        ["ticket", "80", "--json"],
        ["ticket", "79", "--json"],
        ["sync", "--auto-archive"],
      ]) {
        const result = await runMain(args, {
          cwd,
          home: fixture.root,
          env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
        });
        expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(1);
        expect(result.stdout).toBe("");
        if (kind === "tracked") expectTrackingRemedies(result.stderr, plans);
        else {
          expect(result.stderr).toContain(realpathSync(plans));
          expect(result.stderr).toContain(realpathSync(mainPlans));
          expect(result.stderr).toMatch(/linked worktrees.*main worktree/is);
        }
        expect(snapshotTree(cwd)).toEqual(before);
        expect(snapshotTree(mainPlans)).toEqual(mainBefore);
        expect(readFileSync(indexPath)).toEqual(indexBefore);
      }
    },
  );
});

describe("plans setup tracking protection", () => {
  it.each(["directory", "link", "brokenLink"])(
    "refuses a tracked %s before creating folders or migrating anything",
    async (kind) => {
      const fixture = makeFixture();
      const plans = join(fixture.product, ".plans");
      if (kind === "directory") {
        mkdirSync(plans);
        writeFileSync(join(plans, "A1-spec.md"), "original\n");
      } else {
        const target = join(fixture.clone, "existing");
        if (kind === "link") {
          mkdirSync(target);
          writeFileSync(join(target, "A1-spec.md"), "original\n");
        }
        symlinkSync(target, plans);
      }
      git(fixture.product, "add", ".plans");
      git(fixture.product, "commit", "--quiet", "-m", "track plans");
      const before = snapshotTree(fixture.product);
      const cloneBefore = snapshotTree(fixture.clone);
      const indexPath = join(fixture.product, ".git", "index");
      const indexBefore = readFileSync(indexPath);
      const result = await runMain(["plans", "setup", fixture.clone, "--folder", "new-folder"], {
        cwd: fixture.product,
        home: fixture.root,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expectTrackingRemedies(result.stderr, plans);
      expect(snapshotTree(fixture.product)).toEqual(before);
      expect(snapshotTree(fixture.clone)).toEqual(cloneBefore);
      expect(readFileSync(indexPath)).toEqual(indexBefore);
    },
  );

  it("migrates untracked local files and repairs an untracked broken link", async () => {
    const fixture = makeFixture();
    const plans = join(fixture.product, ".plans");
    mkdirSync(join(plans, "78"), { recursive: true });
    writeFileSync(join(plans, "78", "A1-spec.md"), "local\n");
    const options = { cwd: fixture.product, home: fixture.root };
    const migrated = await runMain(
      ["plans", "setup", fixture.clone, "--folder", "migrated"],
      options,
    );
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(lstatSync(plans).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(fixture.clone, "migrated", "78", "A1-spec.md"), "utf8")).toBe(
      "local\n",
    );
    rmSync(plans);
    symlinkSync(join(fixture.root, "missing-clone"), plans);
    const repaired = await runMain(
      ["plans", "setup", fixture.clone, "--folder", "migrated"],
      options,
    );
    expect(repaired.code, repaired.stderr).toBe(0);
    expect(realpathSync(plans)).toBe(realpathSync(join(fixture.clone, "migrated")));
    expect(readFileSync(join(plans, "78", "A1-spec.md"), "utf8")).toBe("local\n");
  });
});

function expectTrackingRemedies(stderr: string, path: string): void {
  expect(stderr).toContain(path);
  expect(stderr).toContain("tracked by this project's repository");
  expect(stderr).toContain("Untrack and ignore these work files in their containing worktree");
  expect(stderr).toContain("then commit before retrying or running");
  expect(stderr).not.toContain("git rm -r --cached .plans");
  expect(stderr).toContain("plans setup <clone-dir>");
  expect(stderr).toContain("companion register");
  expect(stderr).toContain('items[".plans"]');
  expect(stderr).toContain('"companion"');
}

function snapshotTree(path: string): string[] {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return [`link:${readlinkSync(path)}`];
  if (!stats.isDirectory()) return [`file:${readFileSync(path, "utf8")}`];
  return readdirSync(path)
    .filter((name) => name !== ".git")
    .sort()
    .flatMap((name) => [`entry:${name}`, ...snapshotTree(join(path, name))]);
}

describe("plans commands with a companion .plans", () => {
  it("sets up the link in the companion, relative to its parent", async () => {
    const fixture = makeFixture();
    const companion = useCompanion(fixture);
    const link = join(companion, ".plans");
    const result = await runMain(["plans", "setup", fixture.clone, "--folder", "product-plans"], {
      cwd: fixture.product,
      home: fixture.root,
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const target = join("..", "..", "..", "team-plans", "product-plans");
    expect(readlinkSync(link)).toBe(target);
    expect(result.stdout).toContain(`Linked ${link} → ${target}\n`);
    expect(existsSync(join(fixture.product, ".plans"))).toBe(false);

    const options = { cwd: fixture.product, home: fixture.root };
    expect((await runMain(["plans", "check"], options)).stdout).toContain("linked");
    mkdirSync(join(link, "78"));
    const archive = await runMain(["plans", "archive", "78"], options);
    expect(archive.stdout).toContain("Archived 78 → _archives/78");
    expect(existsSync(join(fixture.clone, "product-plans", "_archives", "78"))).toBe(true);
    const stale = join(link, "79");
    mkdirSync(stale);
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, old, old);
    const automatic = await runMain(["plans", "auto-archive"], {
      ...options,
      env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
    });
    expect(automatic.stdout).toContain("Archived 79");
    expect(automatic.stdout).toContain("Publish with: alignfirst sync");
  });

  it("treats a plain companion .plans as local work files", async () => {
    const fixture = makeFixture();
    const plans = join(useCompanion(fixture), ".plans");
    mkdirSync(join(plans, "78"), { recursive: true });
    const options = { cwd: fixture.product, home: fixture.root };
    expect((await runMain(["sync"], options)).stdout).toBe("(local mode, nothing to sync)\n");
    expect((await runMain(["plans", "check"], options)).stdout).toContain("local mode");
    const missing = await runMain(["plans", "archive", "80"], options);
    expect(missing.stderr).toContain(`80 must be an existing directory directly under ${plans}.`);
    expect((await runMain(["plans", "archive", "78"], options)).code).toBe(0);
    expect(existsSync(join(plans, "_archives", "78"))).toBe(true);
  });

  it("accepts _project as a plans folder", async () => {
    const fixture = makeFixture();
    const result = await runMain(["plans", "setup", fixture.clone, "--folder", "_project"], {
      cwd: fixture.product,
    });
    expect(result.code).toBe(0);
    expect(readlinkSync(join(fixture.product, ".plans"))).toBe(
      join("..", "team-plans", "_project"),
    );
  });
});

describe("plans commands with a separate session tree", () => {
  it.each([undefined, "work"])(
    "archives each tree into its own _archives with profile %s",
    async (profile) => {
      const fixture = makeFixture();
      const plans = join(fixture.product, ".plans");
      const sessions = join(useSessionTree(fixture, profile), ".plans");
      const old = new Date(Date.now() - 2 * 86_400_000);
      for (const path of [
        join(plans, "79", "A1-spec.md"),
        join(sessions, "79", "_aligndev", "a.md"),
      ]) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "x\n");
        utimesSync(path, old, old);
      }
      const noTicket = join(sessions, "_aligndev", "20260901-100000.md");
      writeFileSync(noTicket, "---\nstatus: succeeded\n---\n");
      utimesSync(noTicket, old, old);

      const result = await runMain(["plans", "auto-archive"], {
        cwd: fixture.product,
        home: fixture.root,
        env: { ALIGNFIRST_ARCHIVE_DAYS: "1" },
      });

      expect(result.stdout).toContain("Archived 79 → _archives/79");
      expect(result.stdout).toContain("Archived 79 (session tree) → _archives/79");
      expect(result.stdout).toContain("Archived _aligndev/20260901-100000.md (session tree)");
      expect(existsSync(join(plans, "_archives", "79", "A1-spec.md"))).toBe(true);
      expect(existsSync(join(sessions, "_archives", "79", "_aligndev", "a.md"))).toBe(true);
      expect(existsSync(join(sessions, "_archives", "_aligndev", "20260901-100000.md"))).toBe(true);
      expect(existsSync(join(plans, "_archives", "_aligndev"))).toBe(false);
    },
  );

  it("archives a ticket's session directory with the ticket", async () => {
    const fixture = makeFixture();
    const plans = join(fixture.product, ".plans");
    const sessions = join(useSessionTree(fixture), ".plans");
    mkdirSync(join(plans, "78"), { recursive: true });
    mkdirSync(join(sessions, "78", "_aligndev"), { recursive: true });

    const result = await runMain(["plans", "archive", "78"], {
      cwd: fixture.product,
      home: fixture.root,
    });

    expect(result.code).toBe(0);
    expect(existsSync(join(plans, "_archives", "78"))).toBe(true);
    expect(existsSync(join(sessions, "_archives", "78", "_aligndev"))).toBe(true);
    expect(existsSync(join(plans, "_archives", "78", "_aligndev"))).toBe(false);
  });
});

/** Project `.plans`, session tree in `<root>/.alignfirst/companions/product/.plans`. */
function useSessionTree(fixture: Fixture, profile?: string): string {
  writeRegistry(fixture.root, {
    projects: {
      "~/product": {
        dir: "product",
        items: { ".plans": "project", _aligndev: "companion" },
        ...(profile === undefined ? {} : { aligndev: { profile } }),
      },
    },
  });
  const companion = join(fixture.root, ".alignfirst", "companions", "product");
  mkdirSync(join(companion, ".plans", "_aligndev"), { recursive: true });
  mkdirSync(join(fixture.product, ".plans"), { recursive: true });
  return companion;
}

/** The home directory is the fixture root; the companion is `<root>/.alignfirst/companions/product`. */
function useCompanion(fixture: Fixture): string {
  writeRegistry(fixture.root, {
    projects: { "~/product": { dir: "product", items: { ".plans": "companion" } } },
  });
  return join(fixture.root, ".alignfirst", "companions", "product");
}

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
