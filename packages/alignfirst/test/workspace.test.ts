import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureGit,
  git,
  initRepository,
  makeTempDir,
  runMain,
  writeRegistry,
} from "./helpers.js";

const roots: string[] = [];

interface Fixture {
  root: string;
  repo: string;
  home: string;
  target: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("unified workspace inventory and defaults", () => {
  it("prepares companion defaults without checkout runtime/plans placeholders or a runtime ignore rule", async () => {
    const fx = fixture();
    const companion = join(fx.root, "companion");
    mkdirSync(join(companion, ".plans"), { recursive: true });
    writeFileSync(join(fx.repo, ".gitignore"), "");
    commit(fx.repo);
    writeRegistry(fx.home, {
      projects: { [fx.repo]: { dir: companion, defaultLocation: "companion" } },
    });
    const nested = join(fx.repo, "nested");
    mkdirSync(nested);
    const setup = await runMain(
      ["workspace", "setup", "-c", "external", "--path", fx.target, "--json"],
      { cwd: nested, home: fx.home },
    );
    expect(setup.code, setup.stderr).toBe(0);
    const row = JSON.parse(setup.stdout).workspace;
    expect(row).toMatchObject({ recipe: "defaults", preparation: "ready", runtimeState: "active" });
    expect(row.runtimeDir.startsWith(join(companion, ".local-wt/worktrees/"))).toBe(true);
    for (const tree of [fx.repo, fx.target]) {
      expect(existsSync(join(tree, ".local-wt"))).toBe(false);
    }
    expect(existsSync(join(fx.target, ".plans"))).toBe(false);
    expect(existsSync(join(row.runtimeDir, "workspace-registry"))).toBe(false);
    expect(readFileSync(join(fx.target, ".gitignore"), "utf8")).toBe("");
    const registry = join(companion, ".local-wt/workspace-registry/workspaces.json");
    const previous = Object.values(JSON.parse(readFileSync(registry, "utf8")).runtimeOwners);
    expect((await run(fx, ["teardown", fx.target])).code).toBe(0);
    const readopted = await run(fx, ["setup", "--path", fx.target]);
    expect(readopted.code, readopted.stderr).toBe(0);
    expect(Object.values(JSON.parse(readFileSync(registry, "utf8")).runtimeOwners)).not.toEqual(
      previous,
    );
    symlinkSync(row.runtimeDir, join(fx.repo, ".local"));
    const overlapping = await run(fx, ["setup"]);
    expect(overlapping.code).toBe(1);
    expect(overlapping.stderr).toContain("overlaps runtime storage");
  });

  it("publishes project recipe and external cleanup identity before mutable preparation can fail", async () => {
    const fx = fixture();
    const companion = join(fx.root, "companion");
    mkdirSync(join(companion, ".plans"), { recursive: true });
    const marker = join(fx.root, "purged");
    writeRegistry(fx.home, {
      projects: {
        [fx.repo]: {
          dir: companion,
          defaultLocation: "companion",
          items: { alignfirst: "project" },
        },
      },
    });
    writeFileSync(
      join(fx.repo, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspace: {
          preSetup: [
            {
              name: "fail after publication",
              run: [process.execPath, "-e", "throw new Error('mutable preparation failed')"],
            },
          ],
          purge: [
            {
              name: "purge",
              run: [
                process.execPath,
                "-e",
                `require('fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
              ],
            },
          ],
        },
      }),
    );
    commit(fx.repo);
    const failed = await run(fx, ["setup", "-c", "failure", "--path", fx.target]);
    expect(failed.code).toBe(1);
    const registry = join(companion, ".local-wt/workspace-registry/workspaces.json");
    const state = JSON.parse(readFileSync(registry, "utf8"));
    expect(Object.values(state.workspaces)).toMatchObject([
      { status: "failed", recipe: { kind: "manifest", in: "project" } },
    ]);
    expect(Object.values(state.workspaces)).not.toContainEqual(
      expect.objectContaining({ preparationOwner: expect.anything() }),
    );
    expect(Object.values(state.runtimeOwners)).toMatchObject([
      { worktree: fx.target, state: "active" },
    ]);
    const cleaned = await run(fx, ["teardown", fx.target]);
    expect(cleaned.code, cleaned.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(fx.target);
  });

  it("uses companion recipes in target cwd and refuses source substitution before cleanup", async () => {
    const fx = fixture();
    const companion = join(fx.root, "companion");
    const marker = join(fx.root, "purged");
    mkdirSync(companion);
    const recipe = {
      schemaVersion: 1,
      workspace: {
        preSetup: [
          {
            name: "record cwd",
            run: [
              process.execPath,
              "-e",
              "require('fs').writeFileSync('selected-cwd', process.cwd())",
            ],
          },
        ],
        purge: [
          {
            name: "record purge",
            run: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
            ],
          },
        ],
      },
    };
    writeFileSync(join(companion, "alignfirst.json"), JSON.stringify(recipe));
    const select = (source: "project" | "companion") =>
      writeRegistry(fx.home, {
        projects: {
          [fx.repo]: { dir: companion, items: { alignfirst: source, ".plans": "project" } },
        },
      });
    select("companion");
    const setup = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
    expect(setup.code, setup.stderr).toBe(0);
    expect(readFileSync(join(fx.target, "selected-cwd"), "utf8")).toBe(fx.target);
    const registry = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
    const bytes = readFileSync(registry);
    expect(Object.values(JSON.parse(bytes.toString()).workspaces)).toEqual([
      expect.objectContaining({
        recipe: { kind: "manifest", file: "alignfirst.json", in: "companion" },
      }),
    ]);
    writeFileSync(join(fx.target, "alignfirst.json"), JSON.stringify(recipe));
    select("project");
    const refused = await run(fx, ["teardown", fx.target, "--json"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("source changed");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(registry)).toEqual(bytes);
    select("companion");
    rmSync(join(companion, "alignfirst.json"));
    writeFileSync(join(companion, "alignfirst.jsonc"), JSON.stringify(recipe));
    const cleaned = await run(fx, ["teardown", fx.target, "--json"]);
    expect(cleaned.code, cleaned.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe(fx.target);
    expect(existsSync(join(companion, ".local-wt"))).toBe(false);
  });

  it("keeps help independent of Git, plans and malformed project configuration", async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "alignfirst.json"), "{broken");
    for (const args of [
      ["workspace", "--help"],
      ["dev", "--help"],
    ]) {
      const result = await runMain(args, { cwd: fx.root, home: fx.home });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
  });

  it("unions detached, locked, stale and registered-orphan entries without adoption or writes", async () => {
    const fx = fixture();
    const detached = join(fx.root, "detached");
    git(fx.repo, "worktree", "add", "--detach", detached);
    git(fx.repo, "worktree", "lock", "--reason", "external owner", detached);
    const stale = join(fx.root, "stale");
    git(fx.repo, "worktree", "add", "-b", "stale", stale);
    rmSync(stale, { recursive: true });
    expect((await run(fx, ["setup", "-c", "orphan", "--path", fx.target, "--json"])).code).toBe(0);
    git(fx.repo, "worktree", "remove", fx.target);
    const registry = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
    const bytes = readFileSync(registry);
    rmSync(join(fx.repo, ".plans"), { recursive: true });
    const registrations = git(fx.repo, "worktree", "list", "--porcelain", "-z");
    const list = await run(fx, ["list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    const records = JSON.parse(list.stdout).workspaces;
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: fx.repo,
          name: null,
          preparation: "unprepared",
          recipe: null,
        }),
        expect.objectContaining({ path: detached, name: null, branch: null, locked: true }),
        expect.objectContaining({ path: stale, exists: false, prunable: true }),
        expect.objectContaining({
          path: fx.target,
          name: "external target",
          recipe: "defaults",
          preparation: "ready",
          exists: false,
        }),
      ]),
    );
    expect(readFileSync(registry)).toEqual(bytes);
    expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(registrations);
    const status = await run(fx, ["status", "--json"]);
    expect(JSON.parse(status.stdout).workspace.preparation).toBe("unprepared");
    const wait = await run(fx, ["wait", "--json"]);
    expect(wait.code).toBe(1);
    expect(wait.stdout).toBe("");
  });

  it("returns one cleanup document and keeps unprepared removal separate from registration", async () => {
    const fx = fixture();
    expect((await run(fx, ["setup", "-c", "topic", "--path", fx.target])).code).toBe(0);
    rmSync(join(fx.repo, ".plans"), { recursive: true });
    const teardown = await run(fx, ["teardown", fx.target, "--json"]);
    expect(teardown.code, teardown.stderr).toBe(0);
    expect(JSON.parse(teardown.stdout)).toEqual({
      mainWorktree: fx.repo,
      path: fx.target,
      name: "external target",
      operation: "teardown",
      completed: true,
    });
    expect(existsSync(fx.target)).toBe(true);
    const removed = await run(fx, ["remove", fx.target, "--json"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({
      mainWorktree: fx.repo,
      path: fx.target,
      name: null,
      operation: "remove",
      completed: true,
    });
    expect(git(fx.repo, "branch", "--list", "topic")).toContain("topic");
    mkdirSync(join(fx.repo, ".plans"));
    expect((await run(fx, ["setup", "-c", "orphan", "--path", fx.target])).code).toBe(0);
    rmSync(fx.target, { recursive: true });
    const pruned = await run(fx, ["prune", "--json"]);
    expect(pruned.code, pruned.stderr).toBe(0);
    expect(JSON.parse(pruned.stdout)).toEqual({
      mainWorktree: fx.repo,
      pruned: [{ path: fx.target, name: "external target" }],
    });
  });

  it("prepares a new main worktree before its initial commit, preserving the bootstrap index", async () => {
    const fx = fixture(true);
    writeFileSync(join(fx.repo, "alignfirst.json"), '{"schemaVersion":1}\n');
    git(fx.repo, "add", "README.md", "alignfirst.json");
    const index = readFileSync(join(fx.repo, ".git/index"));
    const setup = await run(fx, ["setup", "--json"]);
    expect(setup.code, setup.stderr).toBe(0);
    expect(JSON.parse(setup.stdout).workspace).toMatchObject({
      path: fx.repo,
      branch: "main",
      main: true,
      preparation: "ready",
    });
    expect(readFileSync(join(fx.repo, ".git/index"))).toEqual(index);
    expect(git(fx.repo, "rev-list", "--all")).toBe("");
    const premature = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
    expect(premature.code).toBe(1);
    expect(premature.stdout).toBe("");
    expect(premature.stderr).toContain("HEAD");
    expect(existsSync(fx.target)).toBe(false);
    commit(fx.repo);
    const linked = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
    expect(linked.code, linked.stderr).toBe(0);
    expect(JSON.parse(linked.stdout).workspace.branch).toBe("topic");
  });

  it("shows identity, path, branch and preparation without a custom status summary", async () => {
    const fx = fixture();
    const setup = await run(fx, ["setup", "--json"]);
    expect(setup.code, setup.stderr).toBe(0);
    const status = await run(fx, ["status"]);
    expect(status.code, status.stderr).toBe(0);
    for (const value of ["app", fx.repo, "main", "ready"]) expect(status.stdout).toContain(value);
  });

  it("completes default detached setup synchronously without an empty finalizer", async () => {
    const fx = fixture();
    const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "-d", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mainWorktree: fx.repo,
      workspace: {
        path: fx.target,
        name: "external target",
        branch: "topic",
        main: false,
        exists: true,
        locked: false,
        prunable: false,
        preparation: "ready",
        recipe: "defaults",
        ports: {},
        devSetupFailure: null,
        runtimeDir: join(fx.target, ".local-wt"),
        runtimeState: null,
      },
    });
    expect(result.stderr).not.toContain("continuing in background");
    expect(realpathSync(join(fx.target, ".plans"))).toBe(join(fx.repo, ".plans"));
    expect(realpathSync(join(fx.target, ".local-wt/workspace-registry"))).toBe(
      join(fx.repo, ".local-wt/workspace-registry"),
    );
    expect(git(fx.target, "status", "--porcelain")).toBe("");
    const entered = await run(fx, ["setup", "-c", "other", "--enter", "--json"]);
    expect(entered.code).toBe(1);
    expect(entered.stdout).toBe("");
  });
});

describe("Git and baseline preflight", () => {
  it.each([".plans", ".local-wt"])(
    "refuses staged %s in an unborn repository without changing its index or files",
    async (path) => {
      const fx = fixture(true);
      mkdirSync(join(fx.repo, path), { recursive: true });
      writeFileSync(join(fx.repo, path, "keep"), "staged bytes");
      git(fx.repo, "add", "-f", path);
      const index = readFileSync(join(fx.repo, ".git/index"));
      const result = await run(fx, ["setup", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        path === ".plans" ? /\.plans.*tracked/ : /Runtime storage is tracked/,
      );
      expect(readFileSync(join(fx.repo, ".git/index"))).toEqual(index);
      expect(readFileSync(join(fx.repo, path, "keep"), "utf8")).toBe("staged bytes");
      expect(existsSync(join(fx.repo, ".local-wt/workspace-registry/workspaces.json"))).toBe(false);
    },
  );

  it.each([
    "missingPlans",
    "trackedPlans",
    "unignoredPlans",
    "unignoredRuntime",
    "runtimeFile",
    "runtimeLink",
    "runtimeLogsLink",
    "runtimeLogFileLink",
    "oldRegistry",
    "oldDevRegistry",
    "targetPlans",
    "targetRuntime",
  ])("refuses %s before branch/destination/log writes", async (kind) => {
    const fx = fixture();
    if (kind === "missingPlans") rmSync(join(fx.repo, ".plans"), { recursive: true });
    if (kind === "trackedPlans") {
      writeFileSync(join(fx.repo, ".plans/note"), "tracked");
      git(fx.repo, "add", "-f", ".plans");
      commit(fx.repo);
    }
    if (kind.startsWith("unignored")) {
      writeFileSync(
        join(fx.repo, ".gitignore"),
        kind === "unignoredPlans" ? "/.local-wt/\n" : "/.plans\n",
      );
      commit(fx.repo);
    }
    if (kind === "runtimeFile") writeFileSync(join(fx.repo, ".local-wt"), "keep");
    if (kind === "runtimeLink") symlinkSync(fx.home, join(fx.repo, ".local-wt"));
    if (kind === "runtimeLogsLink") {
      mkdirSync(join(fx.repo, ".local-wt"));
      symlinkSync(fx.home, join(fx.repo, ".local-wt/logs"));
    }
    if (kind === "runtimeLogFileLink") {
      mkdirSync(join(fx.repo, ".local-wt/logs"), { recursive: true });
      symlinkSync(join(fx.repo, "README.md"), join(fx.repo, ".local-wt/logs/workspace-setup.log"));
    }
    if (kind.endsWith("Registry")) {
      mkdirSync(join(fx.repo, ".local-wt/workspace-registry"), { recursive: true });
      writeFileSync(
        join(
          fx.repo,
          ".local-wt/workspace-registry",
          kind === "oldRegistry" ? "workspaces.json" : "dev-servers.json",
        ),
        JSON.stringify({ version: 2, workspaces: {}, servers: [] }),
      );
    }
    let from: string[] = [];
    if (kind.startsWith("target")) {
      const path = kind === "targetPlans" ? ".plans/keep" : ".local-wt/keep";
      mkdirSync(join(fx.repo, path, ".."), { recursive: true });
      writeFileSync(join(fx.repo, path), "target bytes");
      git(fx.repo, "add", "-f", path);
      commit(fx.repo);
      git(fx.repo, "branch", "target-base");
      git(fx.repo, "rm", "--cached", path);
      commit(fx.repo);
      from = ["--from", "target-base"];
    }
    const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, ...from, "--json"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(existsSync(fx.target)).toBe(false);
    expect(git(fx.repo, "branch", "--list", "topic")).toBe("");
    if (!["runtimeLogsLink", "runtimeLogFileLink"].includes(kind))
      expect(existsSync(join(fx.repo, ".local-wt/logs"))).toBe(false);
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toBe("project\n");
  });

  it.each([
    "occupied",
    "existing",
    "dangling",
    "inside",
    "invalidBranch",
    "invalidStart",
    "missingBranch",
    "ambiguousRemote",
  ])("refuses %s intent without partial branches", async (kind) => {
    const fx = fixture();
    let path = fx.target;
    let args = ["-c", "topic"];
    if (kind === "occupied") args = ["main"];
    if (kind === "existing") mkdirSync(path);
    if (kind === "dangling") symlinkSync(join(fx.root, "missing"), path);
    if (kind === "inside") path = join(fx.repo, "nested");
    if (kind === "invalidBranch") args = ["-c", "invalid..branch"];
    if (kind === "invalidStart") args.push("--from", "missing-ref");
    if (kind === "missingBranch") args = ["missing"];
    if (kind === "ambiguousRemote") {
      for (const remote of ["one", "two"])
        git(fx.repo, "update-ref", `refs/remotes/${remote}/topic`, "HEAD");
      args = ["topic"];
    }
    const result = await run(fx, ["setup", ...args, "--path", path, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(git(fx.repo, "branch", "--list", "topic")).toBe("");
  });

  it("reuses local and unambiguous fetched remote branches without fetching", async () => {
    const fx = fixture();
    git(fx.repo, "branch", "local");
    const local = await run(fx, ["setup", "local", "--path", fx.target, "--json"]);
    expect(local.code, local.stderr).toBe(0);
    expect(git(fx.target, "symbolic-ref", "--short", "HEAD")).toBe("local");
    expect(JSON.parse(local.stdout).workspace.branch).toBe("local");
    git(fx.repo, "config", "remote.origin.url", "/unreachable");
    git(fx.repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(fx.repo, "update-ref", "refs/remotes/origin/fetched", "HEAD");
    git(fx.repo, "config", "branch.autoSetupMerge", "false");
    const result = await run(fx, ["setup", "fetched", "--path", join(fx.root, "remote")]);
    expect(result.code, result.stderr).toBe(0);
    expect(git(fx.repo, "config", "branch.fetched.remote")).toBe("origin");
    expect(git(fx.repo, "config", "branch.fetched.merge")).toBe("refs/heads/fetched");
  });
});

describe("exact adoption and safe sharing", () => {
  it("retains partial links after an ignore failure and retries without replacing them", async () => {
    const fx = fixture();
    git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
    writeFileSync(join(fx.target, ".gitignore"), "/.local-wt/\n!/.plans\n");
    const failed = await run(fx, ["setup", "--path", fx.target, "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain(`setup --path '${fx.target}'`);
    expect(realpathSync(join(fx.target, ".plans"))).toBe(join(fx.repo, ".plans"));
    const spelling = readlinkSync(join(fx.target, ".plans"));
    writeFileSync(join(fx.target, ".gitignore"), "/.plans\n/.local-wt/\n");
    const retry = await run(fx, ["setup", "--path", fx.target, "--json"]);
    expect(retry.code, retry.stderr).toBe(0);
    expect(readlinkSync(join(fx.target, ".plans"))).toBe(spelling);
    expect(git(fx.target, "branch", "--show-current")).toBe("topic");
  });

  it.each([".plans", ".local-wt", ".local-wt/data", "."])(
    "refuses explicit sharing of reserved %s storage",
    async (path) => {
      const fx = fixture();
      writeFileSync(
        join(fx.repo, "alignfirst.json"),
        JSON.stringify({ schemaVersion: 1, workspace: { sharedDirs: [path] } }),
      );
      commit(fx.repo);
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("mandatory plans/runtime storage");
      expect(existsSync(join(fx.target, ".plans"))).toBe(false);
    },
  );

  it.each(["missingCompanion", "missingPlans"])(
    "never provisions %s before creation",
    async (kind) => {
      const fx = fixture();
      const companion = join(fx.home, ".alignfirst/companions/app");
      if (kind === "missingPlans") mkdirSync(companion, { recursive: true });
      writeRegistry(fx.home, {
        projects: { [fx.repo]: { dir: "app", items: { ".plans": "companion" } } },
      });
      const registry = join(fx.home, ".alignfirst/companions/registry.json");
      const bytes = readFileSync(registry);
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code).toBe(1);
      expect(existsSync(join(companion, ".plans"))).toBe(false);
      expect(existsSync(fx.target)).toBe(false);
      expect(readFileSync(registry)).toEqual(bytes);
    },
  );

  it.each(["nested", "relative", "detached", "locked"])(
    "adopts %s without changing branches, index or dirty bytes",
    async (kind) => {
      const fx = fixture();
      git(
        fx.repo,
        "worktree",
        "add",
        ...(kind === "detached" ? ["--detach"] : ["-b", "topic"]),
        fx.target,
      );
      if (kind === "locked") git(fx.repo, "worktree", "lock", fx.target);
      mkdirSync(join(fx.repo, ".local"));
      writeFileSync(join(fx.repo, ".local/keep"), "shared");
      writeFileSync(join(fx.target, "README.md"), "staged");
      git(fx.target, "add", "README.md");
      writeFileSync(join(fx.target, "README.md"), "dirty");
      const bytes = Buffer.from([0, 255, 10]);
      writeFileSync(join(fx.target, "unrelated"), bytes);
      const index = git(fx.target, "rev-parse", "--git-path", "index");
      const before = readFileSync(index);
      const refs = git(fx.repo, "show-ref", "--heads");
      const trees = git(fx.repo, "worktree", "list", "--porcelain", "-z");
      const nested = join(fx.target, "nested");
      mkdirSync(nested);
      const result = await run(
        fx,
        [
          "setup",
          ...(kind === "relative" ? ["--path", relative(fx.repo, fx.target)] : []),
          "--json",
        ],
        kind === "relative" ? fx.repo : nested,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).workspace).toMatchObject({
        path: fx.target,
        branch: kind === "detached" ? null : "topic",
        locked: kind === "locked",
        preparation: "ready",
      });
      expect(readFileSync(index)).toEqual(before);
      expect(readFileSync(join(fx.target, "README.md"), "utf8")).toBe("dirty");
      expect(readFileSync(join(fx.target, "unrelated"))).toEqual(bytes);
      expect(readFileSync(join(fx.target, ".local/keep"), "utf8")).toBe("shared");
      expect(git(fx.repo, "show-ref", "--heads")).toBe(refs);
      expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(trees);
    },
  );

  it.each(["missing", "foreign", "subdirectory", "stale"])(
    "rejects explicit %s roots",
    async (kind) => {
      const fx = fixture();
      git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
      let path = fx.target;
      if (kind === "missing") path = join(fx.root, "missing");
      if (kind === "foreign") {
        path = join(fx.root, "foreign");
        initRepository(path);
      }
      if (kind === "subdirectory") {
        path = join(fx.target, "nested");
        mkdirSync(path);
      }
      if (kind === "stale") rmSync(path, { recursive: true });
      const before = git(fx.repo, "worktree", "list", "--porcelain", "-z");
      const result = await run(fx, ["setup", "--path", path, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(before);
      expect(existsSync(join(fx.target, ".plans"))).toBe(false);
    },
  );

  it.each([".plans", ".local", ".local-wt/workspace-registry"])(
    "preflights every destination before applying links for %s conflicts",
    async (name) => {
      for (const kind of ["file", "directory", "wrongLink", "brokenLink", "cyclicLink"]) {
        const fx = fixture();
        git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
        mkdirSync(join(fx.repo, ".local"));
        const path = join(fx.target, name);
        mkdirSync(join(path, ".."), { recursive: true });
        if (kind === "file") writeFileSync(path, "keep");
        if (kind === "directory") mkdirSync(path);
        if (kind === "wrongLink") symlinkSync(fx.home, path);
        if (kind === "brokenLink") symlinkSync(join(fx.root, "missing"), path);
        if (kind === "cyclicLink") symlinkSync(path, path);
        const ino = lstatSync(path).ino;
        const exclude = join(fx.repo, ".git/info/exclude");
        const bytes = readFileSync(exclude);
        const result = await run(fx, ["setup", "--path", fx.target, "--json"]);
        expect(result.code, result.stderr).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(path);
        expect(lstatSync(path).ino).toBe(ino);
        expect(readFileSync(exclude)).toEqual(bytes);
        if (name !== ".plans") expect(existsSync(join(fx.target, ".plans"))).toBe(false);
      }
    },
  );

  it.each(["head", "staged", "stagedMissing", "stagedDeletion", "symlink"])(
    "refuses plans and preserves tracked .local in %s",
    async (kind) => {
      for (const name of [".plans", ".local"]) {
        const fx = fixture();
        git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
        const path = join(fx.target, name);
        if (kind === "symlink") symlinkSync(join(fx.repo, ".plans"), path);
        else {
          mkdirSync(path);
          writeFileSync(join(path, "keep"), "tracked");
        }
        git(fx.target, "add", "-f", name);
        if (["head", "stagedDeletion", "symlink"].includes(kind)) commit(fx.target);
        if (kind === "stagedDeletion") git(fx.target, "rm", "-r", name);
        if (kind === "stagedMissing") rmSync(path, { recursive: true });
        const index = git(fx.target, "rev-parse", "--git-path", "index");
        const before = readFileSync(index);
        const result = await run(fx, ["setup", "--path", fx.target, "--json"]);
        expect(result.code, result.stderr).toBe(name === ".plans" ? 1 : 0);
        expect(readFileSync(index)).toEqual(before);
        if (name === ".local") {
          expect(result.stderr).toContain("remains branch-local");
          if (kind === "stagedDeletion" || kind === "stagedMissing")
            expect(existsSync(path)).toBe(false);
          else if (kind === "symlink") expect(readlinkSync(path)).toBe(join(fx.repo, ".plans"));
          else expect(readFileSync(join(path, "keep"), "utf8")).toBe("tracked");
        }
      }
    },
  );

  it.each(["README.md", ".plans/generated", ".local-wt/generated"])(
    "preflights file destination %s before applying any links",
    async (path) => {
      const fx = fixture();
      writeFileSync(
        join(fx.repo, "alignfirst.json"),
        JSON.stringify({
          schemaVersion: 1,
          workspace: {
            gitignoredFiles: [{ path, source: { kind: "content", content: "never written" } }],
          },
        }),
      );
      commit(fx.repo);
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(existsSync(fx.target)).toBe(true);
      expect(existsSync(join(fx.target, ".plans"))).toBe(false);
      expect(existsSync(join(fx.target, ".local-wt"))).toBe(false);
      expect(existsSync(join(fx.repo, ".local-wt"))).toBe(false);
      expect(readFileSync(join(fx.target, "README.md"), "utf8")).toBe("project\n");
    },
  );

  it.each([
    "missing",
    "trackedMain",
    "trackedAlias",
    "trackedAliasStaged",
    "file",
    "broken",
    "cyclic",
  ])(
    "handles optional .local source %s without replacing unrelated target content",
    async (kind) => {
      const fx = fixture();
      git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
      const source = join(fx.repo, ".local");
      if (kind.startsWith("tracked")) {
        const path = kind.startsWith("trackedAlias") ? join(fx.repo, "tracked-local") : source;
        mkdirSync(path);
        writeFileSync(join(path, "keep"), "source");
        commit(fx.repo);
        if (kind === "trackedAliasStaged") git(fx.repo, "rm", "-r", "--cached", "tracked-local");
        if (kind.startsWith("trackedAlias")) symlinkSync(path, source);
      }
      if (kind === "file") writeFileSync(source, "source file");
      if (kind === "broken") symlinkSync(join(fx.root, "missing"), source);
      if (kind === "cyclic") symlinkSync(".local", source);
      mkdirSync(join(fx.target, ".local"));
      writeFileSync(join(fx.target, ".local/keep"), "unrelated bytes");
      const result = await run(fx, ["setup", "--path", fx.target, "--json"]);
      expect(result.code, result.stderr).toBe(["file", "broken", "cyclic"].includes(kind) ? 1 : 0);
      expect(readFileSync(join(fx.target, ".local/keep"), "utf8")).toBe("unrelated bytes");
      expect(lstatSync(join(fx.target, ".local")).isDirectory()).toBe(true);
      if (kind.startsWith("tracked")) expect(result.stderr).toContain("not shared");
    },
  );

  it("shares optional .local independently of extras and follows subsequent main-link repairs", async () => {
    const fx = fixture();
    const local = join(fx.root, "local source");
    mkdirSync(local);
    symlinkSync(local, join(fx.repo, ".local"));
    writeFileSync(
      join(fx.repo, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, workspace: { sharedDirs: [".shared"] } }),
    );
    git(fx.repo, "add", "alignfirst.json");
    git(fx.repo, "commit", "--quiet", "-m", "manifest");
    const added = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
    expect(added.code, added.stderr).toBe(0);
    expect(realpathSync(join(fx.target, ".local"))).toBe(local);
    expect(realpathSync(join(fx.target, ".shared"))).toBe(join(fx.repo, ".shared"));
    const replacement = join(fx.root, "replacement");
    mkdirSync(replacement);
    rmSync(join(fx.repo, ".local"));
    symlinkSync(replacement, join(fx.repo, ".local"));
    expect(realpathSync(join(fx.target, ".local"))).toBe(replacement);
    expect((await run(fx, ["setup", "--path", fx.target])).code).toBe(0);
  });

  it("accepts equivalent external links without replacing spelling and repairs exclusions idempotently", async () => {
    const fx = fixture();
    git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
    const workfiles = join(fx.root, "work files");
    initRepository(workfiles);
    mkdirSync(join(workfiles, "app"));
    rmSync(join(fx.repo, ".plans"), { recursive: true });
    symlinkSync(join(workfiles, "app"), join(fx.repo, ".plans"));
    const spelling = relative(fx.target, join(workfiles, "app"));
    symlinkSync(spelling, join(fx.target, ".plans"));
    const ino = lstatSync(join(fx.target, ".plans")).ino;
    const exclude = join(fx.repo, ".git/info/exclude");
    writeFileSync(exclude, "# owner without newline");
    for (let iteration = 0; iteration < 2; ++iteration) {
      const result = await run(fx, ["setup", "--path", fx.target, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(readlinkSync(join(fx.target, ".plans"))).toBe(spelling);
      expect(lstatSync(join(fx.target, ".plans")).ino).toBe(ino);
    }
    expect(readFileSync(exclude, "utf8")).toBe("# owner without newline\n/.plans\n");
    writeFileSync(exclude, "# owner without newline");
    expect((await run(fx, ["setup", "--path", fx.target])).code).toBe(0);
    expect(readFileSync(exclude, "utf8")).toBe("# owner without newline\n/.plans\n");
  });

  it.each(["companion", "project"])(
    "preserves %s plans selection, separate sessions and companion bytes",
    async (selection) => {
      const fx = fixture();
      const companion = join(fx.home, ".alignfirst/companions/app");
      mkdirSync(join(companion, ".plans"), { recursive: true });
      writeRegistry(fx.home, {
        projects: {
          [fx.repo]: { dir: "app", items: { ".plans": selection, _aligndev: "companion" } },
        },
      });
      const registry = join(fx.home, ".alignfirst/companions/registry.json");
      const bytes = readFileSync(registry);
      if (selection === "companion") {
        writeFileSync(join(fx.repo, ".plans/unused"), "keep");
        git(fx.repo, "add", "-f", ".plans");
        commit(fx.repo);
      }
      const result = await run(fx, ["setup", "-c", "topic", "--path", fx.target, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(registry)).toEqual(bytes);
      const config = await runMain(["config", "--json"], { cwd: fx.target, home: fx.home });
      const locations = JSON.parse(config.stdout).locations;
      expect(realpathSync(locations[".plans"].path)).toBe(
        selection === "companion" ? join(companion, ".plans") : join(fx.repo, ".plans"),
      );
      expect(locations._aligndev.path).toBe(join(companion, ".plans"));
      if (selection === "companion")
        expect(readFileSync(join(fx.target, ".plans/unused"), "utf8")).toBe("keep");
    },
  );
});

describe("kernel registry ownership at the public boundary", () => {
  it.each([false, true])(
    "preserves registry bytes before rejecting a run-file destination (alias=%s)",
    async (alias) => {
      const fx = fixture();
      expect((await run(fx, ["setup"])).code).toBe(0);
      const registry = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
      const bytes = readFileSync(registry);
      if (alias) symlinkSync(join(fx.repo, ".local-wt/workspace-registry"), join(fx.repo, "alias"));
      const marker = join(fx.root, "producer-ran");
      const manifest = {
        schemaVersion: 1,
        devServer: {
          runFiles: [
            {
              path: alias
                ? "alias/workspaces.json"
                : ".local-wt/workspace-registry/workspaces.json",
              source: {
                kind: "content",
                content: {
                  command: {
                    run: [
                      process.execPath,
                      "-e",
                      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('{}')`,
                    ],
                  },
                },
              },
            },
          ],
          servers: [
            {
              kind: "spawn",
              name: "app",
              exec: { run: [process.execPath, "-e", ""] },
              ready: { log: "ready" },
            },
          ],
        },
      };
      const file = join(fx.repo, "alignfirst.json");
      writeFileSync(file, JSON.stringify(manifest));
      const result = await runMain(["dev", "setup"], { cwd: fx.repo, home: fx.home });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("registry destination");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(registry)).toEqual(bytes);
      manifest.devServer.runFiles[0].path = ".local-wt/application.json";
      writeFileSync(file, JSON.stringify(manifest));
      const sidecar = await runMain(["dev", "setup"], { cwd: fx.repo, home: fx.home });
      expect(sidecar.code, sidecar.stderr).toBe(0);
      expect(readFileSync(join(fx.repo, ".local-wt/application.json"), "utf8")).toBe("{}");
    },
  );

  it("rejects a linked registry belonging to another repository before dispatch", async () => {
    const fx = fixture();
    const foreign = fixture();
    expect((await run(foreign, ["setup"])).code).toBe(0);
    expect((await run(fx, ["setup", "-c", "topic", "--path", fx.target])).code).toBe(0);
    const victim = join(foreign.repo, ".local-wt/workspace-registry/workspaces.json");
    const bytes = readFileSync(victim);
    const link = join(fx.target, ".local-wt/workspace-registry");
    rmSync(link);
    symlinkSync(join(foreign.repo, ".local-wt/workspace-registry"), link);
    for (const args of [
      ["workspace", "list", "--json"],
      ["dev", "down"],
    ]) {
      const result = await runMain(args, { cwd: fx.target, home: fx.home });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("own main worktree");
      expect(readFileSync(victim)).toEqual(bytes);
    }
  });
});

describe("protected deletion", () => {
  it.each([
    "locked",
    "nested",
    "local",
    "extraShared",
    "plans",
    "companion",
    "sessions",
    "invalidRegistry",
  ])("force preserves protected %s targets", async (kind) => {
    const fx = fixture();
    git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
    if (kind === "locked") git(fx.repo, "worktree", "lock", fx.target);
    if (kind === "nested")
      git(fx.repo, "worktree", "add", "-b", "child", join(fx.target, "nested"));
    const shared = join(fx.target, "protected");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep"), "shared bytes");
    if (kind === "local") symlinkSync(shared, join(fx.repo, ".local"));
    if (kind === "extraShared") {
      symlinkSync(shared, join(fx.repo, ".shared"));
      writeFileSync(
        join(fx.repo, "alignfirst.json"),
        JSON.stringify({ schemaVersion: 1, workspace: { sharedDirs: [".shared"] } }),
      );
    }
    if (kind === "plans") {
      rmSync(join(fx.repo, ".plans"), { recursive: true });
      symlinkSync(shared, join(fx.repo, ".plans"));
    }
    if (kind === "companion" || kind === "sessions") {
      mkdirSync(join(shared, ".plans"));
      writeRegistry(fx.home, {
        projects: {
          [fx.repo]: {
            dir: shared,
            items: kind === "sessions" ? { ".plans": "project", _aligndev: "companion" } : {},
          },
        },
      });
    }
    if (kind === "invalidRegistry") {
      writeRegistry(fx.home, { projects: {} });
      writeFileSync(join(fx.home, ".alignfirst/companions/registry.json"), "{broken");
    }
    const registrations = git(fx.repo, "worktree", "list", "--porcelain", "-z");
    const result = await run(fx, ["remove", fx.target, "--force", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    if (["local", "extraShared", "plans", "companion", "sessions"].includes(kind))
      expect(result.stderr).toContain("protected shared directory");
    expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared bytes");
    expect(git(fx.repo, "worktree", "list", "--porcelain", "-z")).toBe(registrations);
  });

  it.each(["modified", "staged", "untracked"])(
    "refuses dirty %s removal and preserves branches",
    async (kind) => {
      const fx = fixture();
      git(fx.repo, "worktree", "add", "-b", "topic", fx.target);
      const path = join(fx.target, kind === "untracked" ? "new" : "README.md");
      writeFileSync(path, "preserve");
      if (kind === "staged") git(fx.target, "add", "README.md");
      const result = await run(fx, ["remove", fx.target, "--json"]);
      expect(result.code).toBe(1);
      expect(readFileSync(path, "utf8")).toBe("preserve");
      expect(git(fx.repo, "branch", "--list", "topic")).toContain("topic");
    },
  );
});

function fixture(unborn = false): Fixture {
  const root = makeTempDir("alignfirst-workspace-");
  roots.push(root);
  configureGit(root);
  const repo = join(root, "app");
  const home = join(root, "home");
  mkdirSync(home);
  if (unborn) {
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "README.md"), "project\n");
  } else initRepository(repo);
  mkdirSync(join(repo, ".plans"));
  writeFileSync(join(repo, ".gitignore"), "/.plans\n/.local-wt/\n");
  if (!unborn) commit(repo);
  return { root, repo, home, target: join(root, "external target") };
}

function run(fx: Fixture, args: string[], cwd = fx.repo) {
  return runMain(["workspace", ...args], {
    cwd,
    home: fx.home,
    env: { ...process.env, HOME: fx.home },
  });
}

function commit(repo: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "fixture");
}
