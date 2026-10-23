import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMachineId } from "../../src/code/machine-id.js";
import { ALIGNFIRST_BIN, writeConfig, writeRegistry, writeSettings } from "../helpers.js";
import {
  addWorktree,
  execGit,
  type Fixture,
  makeFixture,
  makeRepository,
  runAligndev,
  useProjectFixtures,
} from "../project/fixtures.js";

useProjectFixtures();

function project(): { fixture: Fixture; repo: string; destination: string } {
  const fixture = makeFixture();
  const repo = makeRepository(fixture.root, "app");
  mkdirSync(join(repo, ".plans"));
  return { fixture, repo, destination: join(fixture.root, "app ticket") };
}

function run(fixture: Fixture, repo: string, args: string[]) {
  return runAligndev(fixture, ["worktree", ...args], { cwd: repo });
}

function commit(repo: string, ...paths: string[]): void {
  execGit(repo, "add", "--", ...paths);
  execGit(repo, "commit", "--quiet", "-m", "fixture");
}

function companion(fixture: Fixture, repo: string, items: object = {}): string {
  const path = join(fixture.home, ".alignfirst", "companions", "app");
  mkdirSync(join(path, ".plans"), { recursive: true });
  writeRegistry(fixture.home, { projects: { [repo]: { dir: "app", items } } });
  return path;
}

function plans(fixture: Fixture, cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [ALIGNFIRST_BIN, "plans", ...args], {
    cwd,
    env: { ...process.env, HOME: fixture.home },
    encoding: "utf8",
  });
}

describe("worktree discovery and arguments", () => {
  it("keeps help and list independent of settings, agents, markers and AlignFirst", async () => {
    const { fixture, repo } = project();
    writeSettings(fixture.home, { code: false });
    for (const args of [
      ["--help"],
      ["add", "--help"],
      ["list", "--help"],
      ["remove", "--help"],
      ["list", "--json"],
    ]) {
      const result = await runAligndev(fixture, ["worktree", ...args], {
        cwd: repo,
        alignfirstCommand: ["/missing-alignfirst"],
      });
      expect(result.code, result.stderr).toBe(0);
    }
    const result = await run(fixture, repo, ["list", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({
      mainWorktree: repo,
      worktrees: [
        { path: repo, branch: "main", main: true, exists: true, locked: false, prunable: false },
      ],
    });
  });

  it.each([
    ["wat"],
    ["list", "extra"],
    ["list", "-b", "branch"],
    ["add", "path"],
    ["add", "path", "branch", "start"],
    ["remove"],
    ["remove", "path", "--force"],
    ["add", "path", "-b", "branch", "HEAD", "extra"],
    ["--help", "extra"],
  ])("rejects unsupported arguments %j", async (...args) => {
    const { fixture, repo } = project();
    const result = await run(fixture, repo, args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("lists detached, locked and stale entries without repairing the registry", async () => {
    const { fixture, repo } = project();
    const locked = join(fixture.root, "locked");
    const stale = join(fixture.root, "stale");
    execGit(repo, "worktree", "add", "--detach", locked);
    execGit(repo, "worktree", "lock", "--reason", "keep", locked);
    addWorktree(repo, stale, "stale");
    rmSync(stale, { recursive: true });
    const before = execGit(repo, "worktree", "list", "--porcelain");
    const result = await run(fixture, repo, ["list", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).worktrees).toEqual(
      expect.arrayContaining([
        { path: locked, branch: null, main: false, exists: true, locked: true, prunable: false },
        { path: stale, branch: "stale", main: false, exists: false, locked: false, prunable: true },
      ]),
    );
    expect(execGit(repo, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("rejects non-Git, bare and separate-git-dir layouts", async () => {
    const fixture = makeFixture();
    const bare = join(fixture.root, "bare");
    execGit(fixture.root, "init", "--bare", bare);
    const separate = join(fixture.root, "separate");
    execGit(fixture.root, "init", `--separate-git-dir=${join(fixture.root, "metadata")}`, separate);
    for (const cwd of [fixture.root, bare, separate]) {
      const result = await run(fixture, cwd, ["list", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});

describe("worktree add", () => {
  it("shares main directories from a subdirectory with spaces and preserves local excludes", async () => {
    const { fixture, repo, destination } = project();
    mkdirSync(join(repo, ".local"));
    writeFileSync(join(repo, ".local", "evidence"), "keep");
    mkdirSync(join(repo, "sub dir"));
    const exclude = join(repo, ".git", "info", "exclude");
    writeFileSync(exclude, "# original without newline");
    writeFileSync(join(repo, "README.md"), "uncommitted main changes\n");
    const result = await run(fixture, join(repo, "sub dir"), [
      "add",
      destination,
      "-b",
      "ticket",
      "HEAD",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mainWorktree: repo,
      worktree: {
        path: destination,
        branch: "ticket",
        main: false,
        exists: true,
        locked: false,
        prunable: false,
      },
      directories: {
        ".plans": {
          path: join(destination, ".plans"),
          mode: "symlink",
          target: join(repo, ".plans"),
        },
        ".local": {
          path: join(destination, ".local"),
          mode: "symlink",
          target: join(repo, ".local"),
        },
      },
      warnings: [],
    });
    expect(execGit(destination, "status", "--porcelain")).toBe("");
    expect(readFileSync(exclude, "utf8")).toBe("# original without newline\n/.local\n/.plans\n");
    expect(readFileSync(join(destination, ".local", "evidence"), "utf8")).toBe("keep");
    expect(execGit(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("uncommitted main changes\n");
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("app\n");
  });

  it("adds root exclusions once even when directory-only ignore patterns exist", async () => {
    const { fixture, repo, destination } = project();
    writeFileSync(join(repo, ".gitignore"), "/.plans/\n/.local/\n");
    commit(repo, ".gitignore");
    mkdirSync(join(repo, ".local"));
    for (const { path, branch } of [
      { path: destination, branch: "one" },
      { path: join(fixture.root, "two"), branch: "two" },
    ]) {
      const result = await run(fixture, repo, ["add", path, "-b", branch, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(execGit(path, "status", "--porcelain")).toBe("");
    }
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.plans")).toHaveLength(1);
    expect(exclude.split("\n").filter((line) => line === "/.local")).toHaveLength(1);
  });

  it("uses the linked caller's HEAD by default and accepts a relative sibling path", async () => {
    const { fixture, repo } = project();
    const caller = join(fixture.root, "caller");
    addWorktree(repo, caller, "caller");
    writeFileSync(join(caller, "unique"), "caller");
    commit(caller, "unique");
    const result = await run(fixture, caller, ["add", "../next", "-b", "next", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(execGit(join(fixture.root, "next"), "rev-parse", "HEAD")).toBe(
      execGit(caller, "rev-parse", "HEAD"),
    );
    expect(realpathSync(join(fixture.root, "next", ".plans"))).toBe(join(repo, ".plans"));
  });

  it("attaches an existing local branch without detaching HEAD", async () => {
    const { fixture, repo, destination } = project();
    execGit(repo, "branch", "ticket");
    const result = await run(fixture, repo, ["add", destination, "ticket", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(execGit(destination, "branch", "--show-current")).toBe("ticket");
  });

  it("creates an unambiguous fetched remote tracking branch without fetching", async () => {
    const { fixture, repo, destination } = project();
    execGit(repo, "config", "remote.origin.url", join(fixture.root, "unreachable"));
    execGit(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    execGit(repo, "update-ref", "refs/remotes/origin/topic", "HEAD");
    execGit(repo, "config", "branch.autoSetupMerge", "false");
    const result = await run(fixture, repo, ["add", destination, "topic", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(execGit(destination, "branch", "--show-current")).toBe("topic");
    expect(execGit(repo, "config", "branch.topic.remote")).toBe("origin");
    expect(execGit(repo, "config", "branch.topic.merge")).toBe("refs/heads/topic");
  });

  it("refuses ambiguous fetched branches", async () => {
    const { fixture, repo, destination } = project();
    for (const remote of ["one", "two"])
      execGit(repo, "update-ref", `refs/remotes/${remote}/topic`, "HEAD");
    const result = await run(fixture, repo, ["add", destination, "topic", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Ambiguous remote branch");
    expect(existsSync(destination)).toBe(false);
  });

  it.each([
    "occupied",
    "existing",
    "dangling",
    "inside",
    "invalidBranch",
    "invalidStart",
    "missingBranch",
  ])("refuses %s before creation", async (kind) => {
    const { fixture, repo, destination } = project();
    let path = destination;
    let args = ["-b", "ticket"];
    if (kind === "occupied") args = ["main"];
    if (kind === "existing") mkdirSync(path);
    if (kind === "dangling") symlinkSync(join(fixture.root, "missing"), path);
    if (kind === "inside") path = join(repo, "nested");
    if (kind === "invalidBranch") args = ["-b", "invalid..branch"];
    if (kind === "invalidStart") args = ["-b", "ticket", "no-such-ref"];
    if (kind === "missingBranch") args = ["no-such-branch"];
    const result = await run(fixture, repo, ["add", path, ...args, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(execGit(repo, "branch", "--list", "ticket")).toBe("");
    if (kind === "occupied") expect(result.stderr).toContain(repo);
  });

  it("supports source symlink chains into a separate tracked work-files repository", async () => {
    const { fixture, repo, destination } = project();
    const workfiles = makeRepository(fixture.root, "work files");
    mkdirSync(join(workfiles, "app"));
    writeFileSync(join(workfiles, "app", "note.md"), "keep");
    commit(workfiles, "app");
    rmSync(join(repo, ".plans"), { recursive: true });
    symlinkSync(join(workfiles, "app"), join(fixture.root, "alias"));
    symlinkSync(join(fixture.root, "alias"), join(repo, ".plans"));
    const local = join(fixture.root, "local source");
    mkdirSync(local);
    symlinkSync(local, join(repo, ".local"));
    const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(realpathSync(join(destination, ".plans"))).toBe(join(workfiles, "app"));
    expect(realpathSync(join(destination, ".local"))).toBe(local);
    const report = JSON.parse(result.stdout);
    expect(report.directories[".plans"].target).toBe(join(workfiles, "app"));
    expect(report.directories[".local"].target).toBe(local);
    const replacement = join(fixture.root, "replacement local");
    mkdirSync(replacement);
    rmSync(join(repo, ".local"));
    symlinkSync(replacement, join(repo, ".local"));
    expect(realpathSync(join(destination, ".local"))).toBe(replacement);
  });

  it.each(["relocate", "retarget"])(
    "keeps shared plans usable after the main link is repaired to %s its source",
    async (kind) => {
      const { fixture, repo, destination } = project();
      const original = makeRepository(fixture.root, "original work files");
      plans(fixture, repo, "setup", original, "--folder", "app");
      const added = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
      expect(added.code, added.stderr).toBe(0);
      expect(JSON.parse(added.stdout).directories[".plans"].target).toBe(join(original, "app"));
      const replacement = join(fixture.root, "replacement work files");
      if (kind === "relocate") renameSync(original, replacement);
      else makeRepository(fixture.root, "replacement work files");
      plans(fixture, repo, "setup", replacement, "--folder", "app");
      for (const cwd of [repo, destination]) {
        const report = JSON.parse(plans(fixture, cwd, "check", "--json"));
        expect(report.plans.target).toBe(join(replacement, "app"));
      }
    },
  );

  it("surfaces AlignFirst's effective-plans refusal before creating a branch or destination", async () => {
    const { fixture, repo, destination } = project();
    const plans = join(repo, ".plans");
    writeFileSync(join(plans, "tracked"), "tracked");
    commit(repo, ".plans");
    const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(plans);
    expect(result.stderr).toContain("tracked");
    expect(result.stderr).toContain(
      "Untrack and ignore these work files in their containing worktree",
    );
    expect(result.stderr).toContain("plans setup <clone-dir>");
    expect(result.stderr).toContain("guide work-files-setup");
    expect(result.stdout).toBe("");
    expect(existsSync(destination)).toBe(false);
    expect(execGit(repo, "branch", "--list", "ticket")).toBe("");
  });

  it("refuses tracked plans in the target commit before creating the requested branch", async () => {
    const { fixture, repo, destination } = project();
    writeFileSync(join(repo, ".plans", "note"), "target");
    commit(repo, ".plans");
    execGit(repo, "branch", "target");
    execGit(repo, "rm", "--cached", ".plans/note");
    execGit(repo, "commit", "--quiet", "-m", "untrack");
    const result = await run(fixture, repo, [
      "add",
      destination,
      "-b",
      "ticket",
      "target",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Target commit tracks .plans");
    expect(execGit(repo, "branch", "--list", "ticket")).toBe("");
  });

  it.each(["trackedTarget", "trackedMain", "trackedAlias", "missing", "broken", "file"])(
    "handles .local %s",
    async (kind) => {
      const { fixture, repo, destination } = project();
      const local = join(repo, ".local");
      if (kind === "broken") symlinkSync(join(fixture.root, "missing"), local);
      else if (kind === "file") writeFileSync(local, "conflict");
      else if (kind !== "missing") {
        const source = kind === "trackedAlias" ? join(repo, "tracked-local") : local;
        mkdirSync(source);
        writeFileSync(join(source, "keep"), "data");
        commit(repo, kind === "trackedAlias" ? "tracked-local" : ".local");
        if (kind === "trackedAlias") symlinkSync(source, local);
        if (kind === "trackedMain") {
          execGit(repo, "branch", "target", "HEAD~1");
        }
      }
      const result = await run(fixture, repo, [
        "add",
        destination,
        "-b",
        "ticket",
        ...(kind === "trackedMain" ? ["target"] : []),
        "--json",
      ]);
      if (kind === "broken" || kind === "file") {
        expect(result.code).toBe(1);
        expect(existsSync(destination)).toBe(false);
        return;
      }
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).directories[".local"].mode).toBe(
        kind === "trackedTarget" ? "tracked" : "absent",
      );
      expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain(
        "/.local\n",
      );
      if (kind.startsWith("tracked")) expect(result.stderr).toContain("Warning:");
      if (kind === "trackedTarget")
        expect(lstatSync(join(destination, ".local")).isSymbolicLink()).toBe(false);
    },
  );

  it("retains a worktree when its target's config report fails final verification", async () => {
    const { fixture, repo, destination } = project();
    writeFileSync(join(repo, ".alignfirst.json"), "{broken");
    commit(repo, ".alignfirst.json");
    execGit(repo, "branch", "invalid-config");
    execGit(repo, "rm", ".alignfirst.json");
    execGit(repo, "commit", "--quiet", "-m", "remove invalid config");
    const result = await run(fixture, repo, [
      "add",
      destination,
      "-b",
      "ticket",
      "invalid-config",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("effective work-files verification");
    expect(result.stderr).toContain("Retained worktree");
    expect(existsSync(destination)).toBe(true);
    expect(realpathSync(join(destination, ".plans"))).toBe(join(repo, ".plans"));
  });

  it("retains a late-failed worktree and branch with recovery instructions", async () => {
    const { fixture, repo, destination } = project();
    writeFileSync(join(repo, ".gitignore"), "!/.plans\n");
    commit(repo, ".gitignore");
    const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not ignored");
    expect(result.stderr).toContain("Retained worktree");
    expect(result.stderr).toContain("worktree remove");
    expect(existsSync(destination)).toBe(true);
    expect(execGit(repo, "branch", "--list", "ticket")).toContain("ticket");
    expect(existsSync(join(repo, ".plans"))).toBe(true);
  });
});

describe("companion resolution", () => {
  it.each(["auto", "companion", "project"])(
    "honors explicit %s plans selection and preserves registry bytes",
    async (selection) => {
      const { fixture, repo, destination } = project();
      const path = companion(fixture, repo, { ".plans": selection, _aligndev: "companion" });
      if (selection === "auto") {
        // Independent sessions deliberately require an explicit plans choice.
        writeRegistry(fixture.home, { projects: { [repo]: { dir: "app" } } });
      }
      if (selection !== "project") {
        writeFileSync(join(repo, ".plans", "unused-tracked"), "leave alone");
        commit(repo, ".plans");
      }
      const registry = join(fixture.home, ".alignfirst", "companions", "registry.json");
      const before = readFileSync(registry, "utf8");
      const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(registry, "utf8")).toBe(before);
      const directory = JSON.parse(result.stdout).directories[".plans"];
      expect(directory.mode).toBe(selection === "project" ? "symlink" : "companion");
      if (selection !== "project") {
        expect(directory.path).toBe(join(path, ".plans"));
        expect(lstatSync(join(destination, ".plans")).isDirectory()).toBe(true);
      }
      const config = await runAligndev(fixture, ["code", "status", "--no-ticket"], {
        cwd: destination,
      });
      expect(config.code).toBe(1);
      expect(config.stderr).toContain(join(path, ".plans"));
    },
  );

  it("accepts a profile-only registration without creating a companion", async () => {
    const { fixture, repo, destination } = project();
    writeRegistry(fixture.home, {
      projects: { [repo]: { aligndev: { profile: "not-installed" } } },
    });
    const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).directories[".plans"].mode).toBe("symlink");
  });

  it.each(["missingCompanion", "missingPlans", "explicitProject", "malformed"])(
    "does not prepare or mutate %s",
    async (kind) => {
      const { fixture, repo, destination } = project();
      rmSync(join(repo, ".plans"), { recursive: true });
      const path = companion(fixture, repo, {
        ".plans": kind === "explicitProject" ? "project" : "companion",
      });
      if (kind === "missingCompanion") rmSync(path, { recursive: true });
      if (kind === "missingPlans") rmSync(join(path, ".plans"), { recursive: true });
      const registry = join(fixture.home, ".alignfirst", "companions", "registry.json");
      if (kind === "malformed") writeFileSync(registry, "{bad");
      const before = readFileSync(registry, "utf8");
      const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
      expect(result.code).toBe(1);
      expect(readFileSync(registry, "utf8")).toBe(before);
      expect(existsSync(destination)).toBe(false);
      expect(execGit(repo, "branch", "--list", "ticket")).toBe("");
      if (kind === "missingCompanion") expect(existsSync(path)).toBe(false);
    },
  );

  it("can retry after separate authorized companion preparation without copying old files", async () => {
    const { fixture, repo, destination } = project();
    writeFileSync(join(repo, ".plans", "old"), "tracked");
    commit(repo, ".plans");
    expect((await run(fixture, repo, ["add", destination, "-b", "ticket"])).code).toBe(1);
    const path = companion(fixture, repo, { ".plans": "companion" });
    const result = await run(fixture, repo, ["add", destination, "-b", "ticket", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(path, ".plans", "old"))).toBe(false);
    expect(readFileSync(join(repo, ".plans", "old"), "utf8")).toBe("tracked");
  });
});

describe("safe removal", () => {
  it.each([".local", ".plans"])(
    "removes a clean worktree despite a dangling %s link",
    async (name) => {
      const { fixture, repo, destination } = project();
      const added = await run(fixture, repo, ["add", destination, "-b", "ticket"]);
      expect(added.code, added.stderr).toBe(0);
      if (name === ".plans") rmSync(join(repo, name), { recursive: true });
      else symlinkSync(join(fixture.root, "missing local"), join(repo, name));
      const result = await run(fixture, repo, ["remove", destination, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(existsSync(destination)).toBe(false);
      expect(execGit(repo, "branch", "--list", "ticket")).toContain("ticket");
    },
  );

  it("removes with a missing directory target but refuses other resolution errors", async () => {
    const { fixture, repo, destination } = project();
    const added = await run(fixture, repo, ["add", destination, "-b", "ticket"]);
    expect(added.code, added.stderr).toBe(0);
    const local = join(repo, ".local");
    symlinkSync(".local", local);
    const refused = await run(fixture, repo, ["remove", destination, "--json"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("ELOOP");
    expect(existsSync(destination)).toBe(true);
    rmSync(local);
    const file = join(fixture.root, "file");
    writeFileSync(file, "not a directory");
    symlinkSync(join(file, "missing"), local);
    const removed = await run(fixture, repo, ["remove", destination, "--json"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(destination)).toBe(false);
  });

  it("removes from the target itself, preserving branch, sources and companion registration", async () => {
    const { fixture, repo, destination } = project();
    mkdirSync(join(repo, ".local"));
    writeFileSync(join(repo, ".local", "keep"), "data");
    const path = companion(fixture, repo);
    const registry = join(fixture.home, ".alignfirst", "companions", "registry.json");
    const before = readFileSync(registry, "utf8");
    expect((await run(fixture, repo, ["add", destination, "-b", "ticket"])).code).toBe(0);
    const result = await run(fixture, destination, ["remove", destination, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mainWorktree: repo,
      path: destination,
      removed: true,
    });
    expect(existsSync(destination)).toBe(false);
    expect(execGit(repo, "branch", "--list", "ticket")).toContain("ticket");
    expect(readFileSync(join(repo, ".local", "keep"), "utf8")).toBe("data");
    expect(existsSync(join(path, ".plans"))).toBe(true);
    expect(readFileSync(registry, "utf8")).toBe(before);
  });

  it.each(["clean", "dirty", "lockedDirty", "missing", "lockedMissing"])(
    "refuses a clean parent containing a %s registered worktree",
    async (kind) => {
      const { fixture, repo, destination } = project();
      writeFileSync(join(repo, ".gitignore"), "/nested/\n");
      commit(repo, ".gitignore");
      addWorktree(repo, destination, "parent");
      const child = join(destination, "nested");
      addWorktree(repo, child, "child");
      const dirty = kind === "dirty" || kind === "lockedDirty";
      const missing = kind === "missing" || kind === "lockedMissing";
      if (dirty) {
        writeFileSync(join(child, "README.md"), "uncommitted child changes\n");
        writeFileSync(join(child, "uncommitted.txt"), "preserve child data\n");
      }
      if (kind === "lockedDirty" || kind === "lockedMissing")
        execGit(repo, "worktree", "lock", "--reason", "preserve nested worktree", child);
      if (missing) rmSync(child, { recursive: true });
      expect(execGit(destination, "status", "--porcelain")).toBe("");
      const registrations = execGit(repo, "worktree", "list", "--porcelain", "-z");
      const branches = execGit(repo, "show-ref", "--heads");
      const result = await run(fixture, repo, ["remove", destination, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("contains another registered worktree root");
      expect(result.stderr).toContain(child);
      expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("app\n");
      expect(readFileSync(join(destination, ".gitignore"), "utf8")).toBe("/nested/\n");
      expect(execGit(repo, "worktree", "list", "--porcelain", "-z")).toBe(registrations);
      expect(execGit(repo, "show-ref", "--heads")).toBe(branches);
      if (missing) {
        expect(existsSync(child)).toBe(false);
        return;
      }
      expect(readFileSync(join(child, "README.md"), "utf8")).toBe(
        dirty ? "uncommitted child changes\n" : "app\n",
      );
      if (dirty)
        expect(readFileSync(join(child, "uncommitted.txt"), "utf8")).toBe("preserve child data\n");
      expect(execGit(child, "status", "--porcelain")).toBe(
        dirty ? "M README.md\n?? uncommitted.txt" : "",
      );
    },
  );

  it("removes a sibling without affecting a similarly prefixed locked dirty worktree", async () => {
    const { fixture, repo, destination } = project();
    addWorktree(repo, destination, "ticket");
    const sibling = `${destination}-sibling`;
    addWorktree(repo, sibling, "sibling");
    writeFileSync(join(sibling, "uncommitted.txt"), "preserve sibling data\n");
    execGit(repo, "worktree", "lock", "--reason", "preserve sibling", sibling);
    const before = await run(fixture, repo, ["list", "--json"]);
    expect(before.code, before.stderr).toBe(0);
    const branches = execGit(repo, "show-ref", "--heads");
    const result = await run(fixture, repo, ["remove", destination, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).removed).toBe(true);
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(sibling, "uncommitted.txt"), "utf8")).toBe("preserve sibling data\n");
    expect(execGit(repo, "show-ref", "--heads")).toBe(branches);
    const after = await run(fixture, repo, ["list", "--json"]);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout).worktrees).toEqual(
      JSON.parse(before.stdout).worktrees.filter(
        (tree: { path: string }) => tree.path !== destination,
      ),
    );
  });

  it.each(["main", "foreign", "subdir", "locked", "untracked", "modified", "staged"])(
    "refuses %s worktree removal",
    async (kind) => {
      const { fixture, repo, destination } = project();
      expect((await run(fixture, repo, ["add", destination, "-b", "ticket"])).code).toBe(0);
      let path = destination;
      if (kind === "main") path = repo;
      if (kind === "foreign") path = makeRepository(fixture.root, "foreign");
      if (kind === "subdir") {
        path = join(destination, "sub");
        mkdirSync(path);
      }
      if (kind === "locked") execGit(repo, "worktree", "lock", destination);
      if (kind === "untracked") writeFileSync(join(destination, "new"), "keep");
      if (kind === "modified" || kind === "staged")
        writeFileSync(join(destination, "README.md"), "keep");
      if (kind === "staged") execGit(destination, "add", "README.md");
      const result = await run(fixture, repo, ["remove", path, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(existsSync(destination)).toBe(true);
    },
  );

  it.each(["local", "plans", "companion", "sessions", "brokenReport"])(
    "protects %s contents inside a clean linked worktree",
    async (kind) => {
      const { fixture, repo, destination } = project();
      addWorktree(repo, destination, "ticket");
      const shared = join(destination, "protected");
      mkdirSync(shared);
      writeFileSync(join(shared, "keep"), "data");
      execGit(destination, "add", "protected");
      execGit(destination, "commit", "--quiet", "-m", "protected tracked data");
      if (kind === "local") symlinkSync(shared, join(repo, ".local"));
      if (kind === "plans") {
        rmSync(join(repo, ".plans"), { recursive: true });
        symlinkSync(shared, join(repo, ".plans"));
      }
      if (kind === "companion" || kind === "sessions") {
        mkdirSync(join(shared, ".plans"));
        writeFileSync(join(repo, ".git", "info", "exclude"), "/protected/.plans\n");
        writeRegistry(fixture.home, {
          projects: {
            [repo]: {
              dir: shared,
              items: kind === "sessions" ? { ".plans": "project", _aligndev: "companion" } : {},
            },
          },
        });
      }
      if (kind === "brokenReport") {
        writeRegistry(fixture.home, { projects: {} });
        writeFileSync(join(fixture.home, ".alignfirst", "companions", "registry.json"), "bad");
      }
      expect(execGit(destination, "status", "--porcelain")).toBe("");
      const result = await run(fixture, repo, ["remove", destination, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        kind === "brokenReport" ? "protection report" : "protected shared directory",
      );
      expect(readFileSync(join(shared, "keep"), "utf8")).toBe("data");
    },
  );
});

// A tracked-plans refusal must precede stale-run reconciliation and all ticket/launch writes.
describe("coding launch gate", () => {
  it.each(["new", "resume"])(
    "refuses %s before changing a stale session or discovering a model",
    async (command) => {
      const { fixture, repo } = project();
      writeConfig(fixture.home, { code: { agent: "pi" } });
      const sessions = join(repo, ".plans", "_aligndev");
      mkdirSync(sessions);
      const file = join(sessions, "stale.md");
      const contents =
        `---\nagent: pi\nprofile: test\nsessionId: stale\nstatus: running\npid: 2147483647\nmachineId: ${readMachineId(fixture.home)}\nstartedAt: 2026-01-01T00:00:00.000Z\ncwd: ` +
        repo +
        "\n---\n\nkeep\n";
      writeFileSync(file, contents);
      commit(repo, ".plans");
      const result = await runAligndev(
        fixture,
        [
          "code",
          command,
          ...(command === "resume" ? ["stale"] : []),
          "--ticket",
          "123",
          "-m",
          "work",
        ],
        { cwd: repo },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("tracked");
      expect(result.stderr).toContain("guide work-files-setup");
      expect(readFileSync(file, "utf8")).toBe(contents);
      expect(existsSync(join(repo, ".plans", "123"))).toBe(false);
      const status = await runAligndev(fixture, ["code", "status", file, "--result"], {
        cwd: repo,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("status: failed");
      expect(status.stderr).not.toContain("tracked");
      const help = await runAligndev(fixture, ["code", "--help"], { cwd: repo });
      expect(help.code, help.stderr).toBe(0);
    },
  );
});
