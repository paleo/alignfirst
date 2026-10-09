import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, initRepository, makeTempDir, runMain, writeRegistry } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("companion add", () => {
  it("creates the registry, registers the project and creates its companion", async () => {
    const { home, project } = makeHome();
    const result = await runMain(["companion", "add"], { cwd: project, home });
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    expect(result).toEqual({
      code: 0,
      stdout:
        `Registered ~/projects/app in ${registry}.\nCompanion: ${companion} (created)\n` +
        "Next: write the items at the paths `alignfirst config` reports.\n",
      stderr: "",
    });
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({
      paths: { "~/projects/app": {} },
    });
    expect(existsSync(companion)).toBe(true);

    const again = await runMain(["companion", "add"], { cwd: project, home });
    expect(again.stdout).toBe(
      `Already registered by ~/projects/app in ${registry}.\nCompanion: ${companion}\n` +
        "Next: write the items at the paths `alignfirst config` reports.\n",
    );
  });

  it("registers the project beside an ancestor key, from a subdirectory", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects": {} } });
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    mkdirSync(join(project, "src"));
    const result = await runMain(["companion", "add"], { cwd: join(project, "src"), home });
    expect(result.stdout).toContain(`Registered ~/projects/app in ${registry}.`);
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({
      paths: { "~/projects": {}, "~/projects/app": {} },
    });
  });

  it("adds an absolute key for a project outside the home directory", async () => {
    const { root, home } = makeHome();
    const project = join(root, "elsewhere", "app");
    initRepository(project);
    const result = await runMain(["companion", "add"], { cwd: project, home });
    const key = realpathSync(project);
    expect(result.stdout).toContain(`Registered ${key} in `);
    expect(result.stdout).toContain(`companions/${key.slice(1).replaceAll("/", "_")} (created)\n`);
  });

  it("fails outside a git repository", async () => {
    const { root, home } = makeHome();
    const result = await runMain(["companion", "add"], { cwd: root, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("A companion needs a git repository with a main worktree.");
    expect(existsSync(join(home, ".alignfirst"))).toBe(false);
  });
});

describe("companion unregister", () => {
  it("removes the key and reports the orphaned companion directory", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/other": {}, "~/projects/app": { docs: true } } });
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    mkdirSync(join(companion, "docs"), { recursive: true });
    const result = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(result).toEqual({
      code: 0,
      stdout: `Unregistered ~/projects/app from ${registry}.\nOrphaned companion directory: ${companion}\n`,
      stderr: "",
    });
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({ paths: { "~/other": {} } });
    expect(existsSync(join(companion, "docs"))).toBe(true);
  });

  it("marks an empty directory and omits a missing one", async () => {
    const { home, project } = makeHome();
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    await runMain(["companion", "add"], { cwd: project, home });
    const empty = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(empty.stdout).toContain(`Orphaned companion directory: ${companion} (empty)\n`);
    rmSync(companion, { recursive: true });
    await runMain(["companion", "add"], { cwd: project, home });
    rmSync(companion, { recursive: true });
    const missing = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(missing.code).toBe(0);
    expect(missing.stdout).not.toContain("Orphaned");
  });

  it("fails when the project has no key of its own", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects": {} } });
    const result = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${project} is not registered in `);
  });
});

function makeHome(): { root: string; home: string; project: string } {
  const root = realpathSync(makeTempDir("alignfirst-companion-add-"));
  dirs.push(root);
  configureGit(root);
  const home = join(root, "home");
  const project = join(home, "projects", "app");
  initRepository(project);
  return { root, home, project };
}
