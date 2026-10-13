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
      projects: { "~/projects/app": { dir: "projects_app" } },
    });
    expect(existsSync(companionOf(home))).toBe(false);
  });

  it.each([
    [
      "relative to the companions directory",
      "team/app",
      (home: string) => join(home, ".alignfirst", "companions", "team", "app"),
    ],
    [
      "under the home directory",
      "~/companions/app",
      (home: string) => join(home, "companions", "app"),
    ],
    ["absolute", "", (home: string) => join(home, "abs", "app")],
  ])("writes --dir as given: %s", async (_form, value, resolved) => {
    const { home, project } = makeHome();
    const dir = value === "" ? resolved(home) : value;
    const result = await runMain(["companion", "register", "--dir", dir, "--create-dir"], {
      cwd: project,
      home,
    });
    expect(result.stdout).toContain(`Companion: ${resolved(home)} (created)\n`);
    expect(existsSync(resolved(home))).toBe(true);
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      projects: { "~/projects/app": { dir } },
    });
    expect((await runMain(["config", "--json"], { cwd: project, home })).stdout).toContain(
      `"dir": ${JSON.stringify(resolved(home))}`,
    );
  });

  it("rejects a --dir starting with ~ but not ~/", async () => {
    const { home, project } = makeHome();
    const result = await runMain(["companion", "register", "--dir", "~app"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid --dir: ");
    expect(existsSync(registryOf(home))).toBe(false);
  });

  it("accepts an equal --dir on a registered project and refuses a different one", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { projects: { "~/projects/app": { dir: "custom" } } });
    const custom = join(home, ".alignfirst", "companions", "custom");
    const same = await runMain(["companion", "register", "--dir", custom], { cwd: project, home });
    expect(same.code).toBe(0);
    expect(same.stdout).toContain("Already registered by ~/projects/app in ");
    expect(same.stdout).toContain(`Companion: ${custom} (missing)\n`);

    const plain = await runMain(["companion", "register"], { cwd: project, home });
    expect(plain.stdout).toContain(`Companion: ${custom} (missing)\n`);

    const other = await runMain(["companion", "register", "--dir", "other"], {
      cwd: project,
      home,
    });
    expect(other.code).toBe(1);
    expect(other.stderr).toContain(
      `--dir resolves to ${join(home, ".alignfirst", "companions", "other")}, but ~/projects/app ` +
        `is registered with the companion directory ${custom}.`,
    );
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      projects: { "~/projects/app": { dir: "custom" } },
    });
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
    const { home, project } = makeHome();
    writeRegistry(home, { projects: { "~/other": { dir: "shared" } } });
    const shared = join(home, ".alignfirst", "companions", "shared");
    const result = await runMain(["companion", "register", "--dir", shared], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${shared} is already used by ~/other.`,
    );
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      projects: { "~/other": { dir: "shared" } },
    });
  });

  it("registers the project beside an ancestor key, from a subdirectory", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { projects: { "~/projects": { dir: "projects" } } });
    const registry = registryOf(home);
    mkdirSync(join(project, "src"));
    const result = await runMain(["companion", "register"], { cwd: join(project, "src"), home });
    expect(result.stdout).toContain(`Registered ~/projects/app in ${registry}.`);
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({
      projects: { "~/projects": { dir: "projects" }, "~/projects/app": { dir: "projects_app" } },
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
    const { root, home, project } = makeHome();
    const companion = join(root, "companion");
    writeRegistry(home, {
      projects: {
        "~/other": { dir: "other" },
        "~/projects/app": { dir: companion, items: { docs: "companion" } },
      },
    });
    const registry = join(home, ".alignfirst", "companions", "registry.json");
    mkdirSync(join(companion, "docs"), { recursive: true });
    const result = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(result).toEqual({
      code: 0,
      stdout: `Unregistered ~/projects/app from ${registry}.\nOrphaned companion directory: ${companion}\n`,
      stderr: "",
    });
    expect(JSON.parse(readFileSync(registry, "utf-8"))).toEqual({
      projects: { "~/other": { dir: "other" } },
    });
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
    writeRegistry(home, { projects: { "~/projects": { dir: "projects" } } });
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
    writeRegistry(home, { projects: { "~/projects/app": { dir: "projects_app" } } });
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
      projects: { "~/projects/app": { dir: "projects_app" } },
    });
  });

  it("deletes a non-empty companion directory with --force, not a symlink target", async () => {
    const { root, home, project } = makeHome();
    const workFiles = join(root, "work-files");
    mkdirSync(join(workFiles, "app"), { recursive: true });
    writeRegistry(home, { projects: { "~/projects/app": { dir: "projects_app" } } });
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
    const { home, project } = makeHome();
    const companion = join(home, "shared");
    writeRegistry(home, {
      projects: { "~/other": { dir: "~/shared" }, "~/projects/app": { dir: companion } },
    });
    mkdirSync(companion, { recursive: true });
    const result = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${companion} is already used by ~/other.`,
    );
    expect(existsSync(companion)).toBe(true);
  });

  it("rejects --force without --remove-dir", async () => {
    const { home, project } = makeHome();
    writeRegistry(home, { projects: { "~/projects/app": { dir: "projects_app" } } });
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
