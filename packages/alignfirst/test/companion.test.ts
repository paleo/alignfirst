import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withRegistryLock } from "@alignfirst/workspace";
import { resolveProjectLayout } from "../src/project-layout.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureGit, initRepository, makeTempDir, runMain, writeRegistry } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("companion register", () => {
  it("adds a companion to the original profile-only key and preserves the selection through removal", async () => {
    const { root, home, project } = makeHome();
    const alias = join(root, "project-alias");
    symlinkSync(project, alias);
    const aligndev = { profile: "work" };
    writeRegistry(home, {
      projects: {
        [alias]: { aligndev },
        "~/other": { aligndev },
      },
    });
    const registered = await runMain(["companion", "register", "--dir", "chosen", "--create-dir"], {
      cwd: project,
      home,
    });
    expect(registered.code).toBe(0);
    expect(registered.stdout).toContain(`Registered ${alias}`);
    expect(registered.stdout).toContain("(created)");
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      projects: {
        [alias]: { aligndev, dir: "chosen" },
        "~/other": { aligndev },
      },
    });
    const again = await runMain(["companion", "register", "--dir", "chosen"], {
      cwd: project,
      home,
    });
    expect(again.stdout).toContain(`Already registered by ${alias}`);
    const removed = await runMain(["companion", "unregister", "--remove-dir"], {
      cwd: project,
      home,
    });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Kept profile-only entry: work");
    expect(existsSync(join(rootOf(home), "chosen"))).toBe(false);
    const preserved = readFileSync(registryOf(home), "utf-8");
    expect(JSON.parse(preserved)).toEqual({
      projects: { [alias]: { aligndev }, "~/other": { aligndev } },
    });
    const noCompanion = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(noCompanion.code).toBe(1);
    expect(noCompanion.stderr).toContain("has no companion");
    expect(readFileSync(registryOf(home), "utf-8")).toBe(preserved);
  });

  it("validates bounds before adding a directory to a profile-only entry", async () => {
    const { home, project } = makeHome();
    const projects = {
      "~/projects/app": { aligndev: { profile: "work" } },
      "~/other": { dir: "shared" },
    };
    writeRegistry(home, { projects });
    const before = readFileSync(registryOf(home), "utf-8");
    for (const dir of ["shared", "shared/nested", project, home]) {
      const result = await runMain(["companion", "register", "--dir", dir, "--create-dir"], {
        cwd: project,
        home,
      });
      expect(result.code).toBe(1);
      expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
    }
  });
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

  it.each([
    [".", (home: string) => `is ${rootOf(home)}, the companions root.`],
    ["~/.alignfirst", (home: string) => `contains ${rootOf(home)}, the companions root.`],
    ["/", (home: string) => `contains ${rootOf(home)}, the companions root.`],
    [
      "~/projects/app/companion",
      (home: string) => `is inside ${join(home, "projects", "app")}, the project.`,
    ],
    ["~/projects", (home: string) => `contains ${join(home, "projects", "app")}, the project.`],
  ])("refuses the --dir %s", async (dir, conflict) => {
    const { home, project } = makeHome();
    const result = await runMain(["companion", "register", "--dir", dir], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(conflict(home));
    expect(existsSync(registryOf(home))).toBe(false);
  });

  it("refuses the home directory when the companions root is elsewhere", async () => {
    const { root, home, project } = makeHome();
    mkdirSync(join(root, "store"));
    mkdirSync(join(home, ".alignfirst"));
    symlinkSync(join(root, "store"), rootOf(home));
    const result = await runMain(["companion", "register", "--dir", "~/"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `The companion directory ${home} is ${home}, the home directory.`,
    );
  });

  it.each([
    ["team", ["--dir", "team/app"], "team/app", "is inside"],
    ["team/other", ["--dir", "team"], "team", "contains"],
    ["projects_app/other", [], "projects_app", "contains"],
  ])(
    "refuses a companion directory nested with another key's %s: register %j",
    async (otherDir, args, dir, relation) => {
      const { home, project } = makeHome();
      writeRegistry(home, { projects: { "~/other": { dir: otherDir } } });
      const result = await runMain(["companion", "register", ...args], { cwd: project, home });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `The companion directory ${join(rootOf(home), dir)} ${relation} ` +
          `${join(rootOf(home), otherDir)}, the companion directory of ~/other.`,
      );
      expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
        projects: { "~/other": { dir: otherDir } },
      });
    },
  );

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
  it("refuses active/failed resources even with force and retains clean runtime paths on plain unregister", async () => {
    const { home, project } = makeHome();
    const companion = companionOf(home);
    mkdirSync(join(companion, ".plans"), { recursive: true });
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "projects_app",
          defaultLocation: "companion",
          aligndev: { profile: "work" },
          unrelated: 7,
        },
      },
    });
    const setup = await runMain(["workspace", "setup"], { cwd: project, home });
    expect(setup.code, setup.stderr).toBe(0);
    for (const flags of [[], ["--remove-dir", "--force"]]) {
      const refused = await runMain(["companion", "unregister", ...flags], { cwd: project, home });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("workspace resources");
      expect(existsSync(companion)).toBe(true);
    }
    const runtime = resolveProjectLayout(project, home).storage.runtimeDir;
    expect((await runMain(["workspace", "teardown"], { cwd: project, home })).code).toBe(0);
    const removed = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`Retained runtime: ${runtime}`);
    expect(removed.stdout).toContain("Automatic discovery is being removed");
    expect(existsSync(runtime)).toBe(true);
    expect(JSON.parse(readFileSync(registryOf(home), "utf8")).projects["~/projects/app"]).toEqual({
      aligndev: { profile: "work" },
      unrelated: 7,
    });
  });

  it("keeps registration when authorized directory deletion fails", async () => {
    const { home, project } = makeHome();
    await runMain(["companion", "register", "--create-dir"], { cwd: project, home });
    const bytes = readFileSync(registryOf(home), "utf8");
    writeFileSync(join(companionOf(home), "retained"), "evidence");
    chmodSync(companionOf(home), 0o500);
    try {
      const failed = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
        cwd: project,
        home,
      });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("EACCES");
    } finally {
      chmodSync(companionOf(home), 0o700);
    }
    expect(readFileSync(registryOf(home), "utf8")).toBe(bytes);
    expect(
      (
        await runMain(["companion", "unregister", "--remove-dir", "--force"], {
          cwd: project,
          home,
        })
      ).code,
    ).toBe(0);
  });

  it("gates setup while unregister waits for the selected runtime lock", async () => {
    const { home, project } = makeHome();
    const companion = companionOf(home);
    mkdirSync(join(companion, ".plans"), { recursive: true });
    writeRegistry(home, {
      projects: { "~/projects/app": { dir: "projects_app", defaultLocation: "companion" } },
    });
    const storage = resolveProjectLayout(project, home).storage;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = withRegistryLock(project, storage.registryDir, async () => {
      entered();
      await barrier;
    });
    await locked;
    const unregister = runMain(["companion", "unregister"], { cwd: project, home });
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(registryOf(home), "utf8")).projects["~/projects/app"].removalClaim
            ?.pid,
      )
      .toBe(process.pid);
    const setup = runMain(["workspace", "setup"], { cwd: project, home });
    release();
    await holding;
    const [removed, refused] = await Promise.all([unregister, setup]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/removal is in progress|selection changed/);
    expect(existsSync(storage.runtimeDir)).toBe(false);
    const state = JSON.parse(readFileSync(join(storage.registryDir, "workspaces.json"), "utf8"));
    expect(state.workspaces).toEqual({});
    expect(state.runtimeOwners).toEqual({});
  });

  it("keeps combined entries unchanged on refusal and removes items while preserving profiles", async () => {
    const { home, project } = makeHome();
    const aligndev = { profile: "work" };
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "projects_app",
          items: { docs: "companion" },
          aligndev,
        },
      },
    });
    mkdirSync(join(companionOf(home), "docs"), { recursive: true });
    const before = readFileSync(registryOf(home), "utf-8");
    const refused = await runMain(["companion", "unregister", "--remove-dir"], {
      cwd: project,
      home,
    });
    expect(refused.code).toBe(1);
    expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
    const removed = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Orphaned companion directory:");
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      projects: { "~/projects/app": { aligndev } },
    });
  });
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

  it("keeps a companion directory outside the companions root, even with --force", async () => {
    const { root, home, project } = makeHome();
    const companion = join(root, "companion");
    writeRegistry(home, { projects: { "~/projects/app": { dir: companion } } });
    mkdirSync(join(companion, "docs"), { recursive: true });
    const result = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
      cwd: project,
      home,
    });
    expect(result).toEqual({
      code: 0,
      stdout:
        `Unregistered ~/projects/app from ${registryOf(home)}.\n` +
        `Orphaned companion directory: ${companion}\n` +
        "Kept: it is outside ~/.alignfirst/companions. Remove it by hand.\n",
      stderr: "",
    });
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({ projects: {} });
    expect(existsSync(join(companion, "docs"))).toBe(true);
  });

  it.each([
    [".", (home: string) => `is ${rootOf(home)}, the companions root.`],
    ["~/.alignfirst", (home: string) => `contains ${rootOf(home)}, the companions root.`],
    [
      "team",
      (home: string) =>
        `contains ${join(rootOf(home), "team", "other")}, the companion directory of ~/other.`,
    ],
  ])("refuses to remove the companion directory %s, and changes nothing", async (dir, conflict) => {
    const { home, project } = makeHome();
    const projects = { "~/other": { dir: "team/other" }, "~/projects/app": { dir } };
    writeRegistry(home, { projects });
    mkdirSync(join(rootOf(home), "team", "other"), { recursive: true });
    const result = await runMain(["companion", "unregister", "--remove-dir", "--force"], {
      cwd: project,
      home,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(conflict(home));
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({ projects });
    expect(existsSync(join(rootOf(home), "team", "other"))).toBe(true);
  });

  it("refuses to remove a companion directory another key uses, even with --force", async () => {
    const { home, project } = makeHome();
    const companion = join(rootOf(home), "shared");
    writeRegistry(home, {
      projects: { "~/other": { dir: "shared" }, "~/projects/app": { dir: companion } },
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

describe("companion registry preservation", () => {
  it("round-trips a new registration without losing obsolete or unrelated settings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    const secret = "PRIVATE-EXTENSION-VALUE";
    const original = {
      root: secret,
      paths: { "~/legacy": { docs: true, extra: secret } },
      extra: { nested: [secret, null, false] },
      projects: {
        "~/other": {
          dir: "other",
          extra: { nested: secret },
          items: { docs: "project", extra: { nested: secret } },
          aligndev: { profile: "other", extra: { nested: secret } },
        },
      },
    };
    writeRegistry(home, original);
    const registered = await runMain(["companion", "register"], { cwd: project, home });
    expect(registered.code).toBe(0);
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
      ...original,
      projects: { ...original.projects, "~/projects/app": { dir: "projects_app" } },
    });
    const removed = await runMain(["companion", "unregister"], { cwd: project, home });
    expect(removed.code).toBe(0);
    expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual(original);
    const before = readFileSync(registryOf(home), "utf-8");
    const report = await runMain(["config", "--json"], { cwd: project, home });
    expect(report.code).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ aligndev: null, companion: null });
    expect(report.stdout).not.toContain(secret);
    expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
    const warnings = warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("convert paths manually");
    expect(warnings).toContain("projects[<entry>].items.extra");
    expect(warnings).toContain("projects[<entry>].aligndev.extra");
    expect(warnings).not.toContain(secret);
    expect(warnings).not.toContain("~/other");
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "preserves %s extension keys through profile-only registration and removal",
    async (key) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { root, home, project } = makeHome();
      const alias = join(root, "project-alias");
      symlinkSync(project, alias);
      const extension = { [key]: { profile: "PRIVATE", polluted: true } };
      const aligndev = { profile: "work", ...extension };
      const profileEntry = { aligndev, ...extension };
      const original = {
        ...extension,
        projects: { [alias]: profileEntry, "~/other": { dir: "other", ...extension } },
      };
      writeRegistry(home, original);
      const registered = await runMain(["companion", "register", "--dir", "chosen"], {
        cwd: project,
        home,
      });
      expect(registered.code).toBe(0);
      const withCompanion = {
        ...original,
        projects: {
          ...original.projects,
          [alias]: {
            ...profileEntry,
            dir: "chosen",
            defaultLocation: "companion",
            items: { docs: "project", workspaceRuntime: "auto", ...extension },
          },
        },
      };
      expect(JSON.parse(readFileSync(registryOf(home), "utf-8"))).toEqual({
        ...original,
        projects: { ...original.projects, [alias]: { ...profileEntry, dir: "chosen" } },
      });
      writeRegistry(home, withCompanion);
      const before = readFileSync(registryOf(home), "utf-8");
      const again = await runMain(["companion", "register"], { cwd: project, home });
      expect(again.code).toBe(0);
      expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
      const report = await runMain(["config", "--json"], { cwd: project, home });
      expect(report.code).toBe(0);
      const parsed = JSON.parse(report.stdout);
      expect(parsed.aligndev).toEqual({ profile: "work" });
      expect(parsed.companion.items.docs).toBe("project");
      expect(parsed.companion.defaultLocation).toBe("companion");
      expect(parsed.selectionOrigins.docs).toBe("item");
      expect(parsed.selectionOrigins.workspaceRuntime).toBe("item");
      expect(parsed.selectionOrigins.alignfirst).toBe("defaultLocation");
      expect(Object.hasOwn(parsed.companion.items, key)).toBe(false);
      expect(report.stdout).not.toContain("PRIVATE");
      expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
      const removed = await runMain(["companion", "unregister"], { cwd: project, home });
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain("Kept profile-only entry: work");
      const remaining = JSON.parse(readFileSync(registryOf(home), "utf-8"));
      expect(remaining).toEqual(original);
      expect(Object.hasOwn(remaining, key)).toBe(true);
      expect(Object.hasOwn(remaining.projects[alias], key)).toBe(true);
      expect(Object.hasOwn(remaining.projects[alias].aligndev, key)).toBe(true);
      expect(Object.getPrototypeOf(remaining)).toBe(Object.prototype);
      expect(Object.prototype).not.toHaveProperty("polluted");
      expect(warn.mock.calls.flat().join("\n")).not.toContain("PRIVATE");
    },
  );

  it.each([
    { dir: "app", items: { docs: "PRIVATE" } },
    { dir: "app", aligndev: { profile: "  " } },
    { dir: "~invalid" },
    { dir: "app", items: { _aligndev: "companion" } },
  ])("rejects known-invalid settings before either mutation: %j", async (entry) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    writeRegistry(home, {
      paths: { "~/legacy": { docs: true } },
      extra: "PRIVATE",
      projects: { "~/projects/app": entry },
    });
    const before = readFileSync(registryOf(home), "utf-8");
    for (const args of [
      ["companion", "register", "--dir", "chosen", "--create-dir"],
      ["companion", "unregister", "--remove-dir", "--force"],
    ]) {
      const result = await runMain(args, { cwd: project, home });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Invalid ${registryOf(home)}`);
      expect(result.stderr).not.toContain("PRIVATE");
      expect(readFileSync(registryOf(home), "utf-8")).toBe(before);
      expect(existsSync(join(rootOf(home), "chosen"))).toBe(false);
    }
  });
});

function rootOf(home: string): string {
  return join(home, ".alignfirst", "companions");
}

function registryOf(home: string): string {
  return join(rootOf(home), "registry.json");
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
