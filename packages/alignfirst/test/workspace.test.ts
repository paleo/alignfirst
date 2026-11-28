import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { git, makeTempDir, runMain, writeRegistry } from "./helpers.js";
import {
  commit,
  removeWorkspaceFixtures,
  runWorkspace as run,
  workspaceFixture as fixture,
} from "./workspace-fixture.js";

afterEach(removeWorkspaceFixtures);

describe("alignfirst workspace recipes", () => {
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
    const dir = makeTempDir("alignfirst-workspace-help-");
    try {
      writeFileSync(join(dir, "alignfirst.json"), "{broken");
      for (const args of [
        ["workspace", "--help"],
        ["dev", "--help"],
      ]) {
        const result = await runMain(args, { cwd: dir, home: dir });
        expect(result.code, result.stderr).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace JSON documents read by the AlignDev playbook", () => {
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
