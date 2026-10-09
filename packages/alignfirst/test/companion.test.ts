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

  it("keeps the registry when a parent key already matches", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects": { ".plans": false } } });
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    const before = readFileSync(registry, "utf-8");
    mkdirSync(join(project, "src"));
    const result = await runMain(["companion", "add"], { cwd: join(project, "src"), home });
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    expect(result.stdout).toContain(
      `Already registered by ~/projects in ${registry}.\nCompanion: ${companion} (created)\n`,
    );
    expect(readFileSync(registry, "utf-8")).toBe(before);
    expect(existsSync(companion)).toBe(true);
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

function makeHome(): { root: string; home: string; project: string } {
  const root = realpathSync(makeTempDir("alignfirst-companion-add-"));
  dirs.push(root);
  configureGit(root);
  const home = join(root, "home");
  const project = join(home, "projects", "app");
  initRepository(project);
  return { root, home, project };
}
