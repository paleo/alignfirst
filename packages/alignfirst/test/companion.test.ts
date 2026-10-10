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

import { configureGit, initRepository, makeTempDir, runMain, writeRegistry } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("companion register", () => {
  it("creates the registry and registers the project, without its companion", async () => {
    const { home, project } = makeHome();
    const result = await runMain(["companion", "register"], { cwd: project, home });
    expect(result).toEqual({
      code: 0,
      stdout:
        `Registered ~/projects/app in ${registryOf(home)}.\nCompanion: ${companionOf(home)} (missing)\n` +
        "Next: write the items at the paths `alignfirst config` reports.\n",
      stderr: "",
    });
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      paths: { "~/projects/app": {} },
    });
    expect(existsSync(companionOf(home))).toBe(false);
  });

  it("creates the companion with --create-dir, even when registered", async () => {
    const { home, project } = makeHome();
    await runMain(["companion", "register"], { cwd: project, home });
    const result = await runMain(["companion", "register", "--create-dir"], { cwd: project, home });
    expect(result.stdout).toBe(
      `Already registered by ~/projects/app in ${registryOf(home)}.\n` +
        `Companion: ${companionOf(home)} (created)\n` +
        "Next: write the items at the paths `alignfirst config` reports.\n",
    );
    expect(existsSync(companionOf(home))).toBe(true);
    const again = await runMain(["companion", "register"], { cwd: project, home });
    expect(again.stdout).toContain(`Companion: ${companionOf(home)}\n`);
  });

  it("refuses a project whose companion directory another key uses", async () => {
    const { home } = makeHome();
    const project = join(home, "a", "b_c");
    initRepository(project);
    writeRegistry(home, { paths: { "~/a_b/c": {} } });
    const result = await runMain(["companion", "register"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${join(home, ".alignfirst", "companions", "a_b_c")} is already used by ~/a_b/c.`,
    );
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      paths: { "~/a_b/c": {} },
    });
  });

  it("registers the project beside an ancestor key, from a subdirectory", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects": {} } });
    const registry = registryOf(home);
    mkdirSync(join(project, "src"));
    const result = await runMain(["companion", "register"], { cwd: join(project, "src"), home });
    expect(result.stdout).toContain(`Registered ~/projects/app in ${registry}.`);
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({
      paths: { "~/projects": {}, "~/projects/app": {} },
    });
  });

  it("adds an absolute key for a project outside the home directory", async () => {
    const { root, home } = makeHome();
    const project = join(root, "elsewhere", "app");
    initRepository(project);
    const result = await runMain(["companion", "register"], { cwd: project, home });
    const key = realpathSync(project);
    expect(result.stdout).toContain(`Registered ${key} in `);
    expect(result.stdout).toContain(`companions/${key.slice(1).replaceAll("/", "_")} (missing)\n`);
  });

  it("fails outside a git repository", async () => {
    const { root, home } = makeHome();
    const result = await runMain(["companion", "register"], { cwd: root, home });
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
    const companion = companionOf(home);
    await runMain(["companion", "register", "--create-dir"], { cwd: project, home });
    const empty = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(empty.stdout).toContain(`Orphaned companion directory: ${companion} (empty)\n`);
    rmSync(companion, { recursive: true });
    await runMain(["companion", "register"], { cwd: project, home });
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

  it("removes an empty companion directory with --remove-dir", async () => {
    const { home, project } = makeHome();
    await runMain(["companion", "register", "--create-dir"], { cwd: project, home });
    const result = await runMain(["companion", "unregister", "--remove-dir"], {
      cwd: project,
      home,
    });
    expect(result.stdout).toBe(
      `Unregistered ~/projects/app from ${registryOf(home)}.\n` +
        `Removed companion directory: ${companionOf(home)}\n`,
    );
    expect(existsSync(companionOf(home))).toBe(false);
  });

  it("refuses a non-empty companion directory without --force, and changes nothing", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects/app": {} } });
    mkdirSync(join(companionOf(home), "docs"), { recursive: true });
    writeFileSync(join(companionOf(home), "DEVELOPERS.md"), "");
    const result = await runMain(["companion", "unregister", "--remove-dir"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${companionOf(home)} is not empty: DEVELOPERS.md, docs. ` +
        "Add --force to delete it.",
    );
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      paths: { "~/projects/app": {} },
    });
  });

  it("deletes a non-empty companion directory with --force, not a symlink target", async () => {
    const { root, home, project } = makeHome();
    const workFiles = join(root, "work-files");
    mkdirSync(join(workFiles, "app"), { recursive: true });
    writeRegistry(home, { paths: { "~/projects/app": {} } });
    mkdirSync(join(companionOf(home), "docs"), { recursive: true });
    symlinkSync(join(workFiles, "app"), join(companionOf(home), ".plans"));
    const result = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Removed companion directory: ${companionOf(home)}\n`);
    expect(existsSync(companionOf(home))).toBe(false);
    expect(existsSync(join(workFiles, "app"))).toBe(true);
  });

  it("refuses to remove a companion directory another key uses, even with --force", async () => {
    const { home } = makeHome();
    const project = join(home, "a", "b_c");
    initRepository(project);
    writeRegistry(home, { paths: { "~/a_b/c": {}, "~/a/b_c": {} } });
    const companion = join(home, ".alignfirst", "companions", "a_b_c");
    mkdirSync(companion, { recursive: true });
    const result = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${companion} is already used by ~/a_b/c.`,
    );
    expect(existsSync(companion)).toBe(true);
  });

  it("rejects --force without --remove-dir", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects/app": {} } });
    const result = await runMain(["companion", "unregister", "--force"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--force requires --remove-dir.");
  });
});

function registryOf(home: string): string {
  return join(home, ".alignfirst", "companions", "registry.json");
}

function companionOf(home: string): string {
  return join(home, ".alignfirst", "companions", "projects_app");
}

function makeHome(): { root: string; home: string; project: string } {
  const root = realpathSync(makeTempDir("alignfirst-companion-add-"));
  dirs.push(root);
  configureGit(root);
  const home = join(root, "home");
  const project = join(home, "projects", "app");
  initRepository(project);
  return { root, home, project };
}
