import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registryPath,
  resolveProjectLayout,
  separateSessionTree,
  sharedCompanionDirs,
  nestedCompanionDirs,
  strayRegistryKeys,
} from "../src/project-layout.js";
import { configureGit, git, initRepository, makeTempDir, writeRegistry } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project layout", () => {
  it("resolves every item in the project without a registry", () => {
    const { home, project } = makeHome();
    const layout = resolveProjectLayout(project, home);
    expect(layout.companion).toBeNull();
    expect(layout.aligndev).toBeNull();
    expect(layout.locations[".plans"]).toEqual({
      path: join(project, ".plans"),
      in: "project",
      exists: false,
    });
    expect(layout.locations._aligndev).toEqual(layout.locations[".plans"]);
  });

  it("warns at every settings level, redacts map keys and leaves the registry unchanged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    const secret = "PRIVATE-SETTING-VALUE";
    writeRegistry(home, {
      root: secret,
      paths: { [secret]: { docs: true } },
      extra: { nested: secret },
      projects: {
        "~/projects/app": {
          dir: "app",
          extra: secret,
          items: { docs: "project", extra: secret },
          aligndev: { profile: "work", extra: secret },
        },
        [`~/${secret}`]: { aligndev: { profile: "other", extra: secret } },
      },
    });
    const before = readFileSync(registryPath(home), "utf-8");
    const layout = resolveProjectLayout(project, home);
    expect(layout.aligndev).toEqual({ profile: "work" });
    expect(layout.companion?.items.docs).toBe("project");
    expect(layout.companion?.items).not.toHaveProperty("extra");
    expect(warn).toHaveBeenCalledTimes(7);
    const warnings = warn.mock.calls.flat().join("\n");
    for (const field of [
      "root",
      "paths",
      "extra",
      "projects[<entry>].extra",
      "projects[<entry>].items.extra",
      "projects[<entry>].aligndev.extra",
    ])
      expect(warnings).toContain(`setting ${field}.`);
    expect(warnings).toContain("convert paths manually");
    expect(warnings).toContain("Use a symlink");
    expect(warnings).not.toContain(secret);
    expect(warnings).not.toContain("~/projects/app");
    expect(readFileSync(registryPath(home), "utf-8")).toBe(before);
  });

  it("ignores obsolete paths even when projects is absent, but still requires projects", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    writeRegistry(home, { paths: { "~/projects/app": { docs: true } } });
    expect(() => resolveProjectLayout(project, home)).toThrow("projects must be an object");
    expect(warn.mock.calls.flat().join("\n")).toContain("convert paths manually");
    writeRegistry(home, { paths: "PRIVATE", projects: {} });
    expect(resolveProjectLayout(project, home).companion).toBeNull();
  });

  it("does not treat project-map keys or supported item names as unknown settings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "app",
          items: {
            ".alignfirst.json": "project",
            ".alignfirst-instructions": "auto",
            "DEVELOPERS.md": "companion",
            docs: "project",
            ".plans": "project",
            _aligndev: "companion",
          },
        },
        "/other/path": { aligndev: { profile: "work" } },
      },
    });
    expect(resolveProjectLayout(project, home).companion).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still validates known values and semantics when unknown settings are present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { home, project } = makeHome();
    for (const entry of [
      { dir: "app", items: { docs: "PRIVATE" } },
      { dir: "app", aligndev: { profile: "  " } },
      { items: {}, aligndev: { profile: "work" } },
      { dir: "app", items: { _aligndev: "companion" } },
    ]) {
      writeRegistry(home, { extra: "PRIVATE", projects: { "~/projects/app": entry } });
      expect(() => resolveProjectLayout(project, home)).toThrow("Invalid");
      expect(() => resolveProjectLayout(project, home)).not.toThrow("PRIVATE");
    }
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["{", "JSON"],
    ['{"projects": {}, "extra": "PRIVATE", BROKEN}', "must contain valid JSON"],
    [JSON.stringify(null), "must be an object"],
    [JSON.stringify([]), "must be an object"],
    [JSON.stringify({}), "projects must be an object"],
    [JSON.stringify({ projects: [] }), "projects must be an object"],
    [JSON.stringify({ projects: { "~/p": null } }), "must be an object"],
    [JSON.stringify({ projects: { "~/p": { dir: "p", items: [] } } }), "items must be an object"],
    [JSON.stringify({ projects: { "~/p": {} } }), 'define "dir" or "aligndev"'],
    [JSON.stringify({ projects: { "~/p": { items: {} } } }), 'define "dir" when "items"'],
    [JSON.stringify({ projects: { "~/p": { aligndev: {} } } }), "profile must"],
    [JSON.stringify({ projects: { "~/p": { aligndev: null } } }), "aligndev must"],
    [JSON.stringify({ projects: { "~/p": { aligndev: { profile: 1 } } } }), "profile must"],
    [JSON.stringify({ projects: { "~/p": { aligndev: { profile: "" } } } }), "profile must"],
    [JSON.stringify({ projects: { "~/p": { aligndev: { profile: "  " } } } }), "nonblank"],
    [JSON.stringify({ projects: { "~/p": { dir: " " } } }), "nonblank path"],
    [JSON.stringify({ projects: { "~/p": { dir: "a\u0000b" } } }), "nonblank path"],
    [JSON.stringify({ projects: { "~/p": { dir: "" } } }), "dir must be a non-empty string"],
    [JSON.stringify({ projects: { "~/p": { dir: "~x" } } }), "dir must be a relative path"],
    [JSON.stringify({ projects: { "~/p": { dir: "~" } } }), "dir must be a relative path"],
    [JSON.stringify({ projects: { "~/p": { dir: "p", items: { docs: true } } } }), "docs must be"],
    [
      JSON.stringify({ projects: { "~/p": { dir: "p", items: { _aligndev: "project" } } } }),
      '_aligndev must be "companion" or "auto"',
    ],
    [
      JSON.stringify({ projects: { "/a": { dir: "a" }, "p/q": { dir: "q" } } }),
      "projects key must be",
    ],
    [JSON.stringify({ projects: { "~p": { dir: "p" } } }), "projects key must be"],
  ])("rejects an invalid file %#", (content, message) => {
    const { home, project } = makeHome();
    mkdirSync(join(home, ".alignfirst", "companions"), { recursive: true });
    writeFileSync(registryPath(home), content);
    expect(() => resolveProjectLayout(project, home)).toThrow(`Invalid ${registryPath(home)}: `);
    expect(() => resolveProjectLayout(project, home)).toThrow(message);
  });

  it("shares a profile-only selection through symlink keys and linked worktrees without redirecting files", () => {
    const { root, home, project } = makeHome();
    const linked = join(root, "linked");
    git(project, "worktree", "add", "--quiet", "-b", "feature", linked);
    const alias = join(root, "alias");
    symlinkSync(project, alias);
    const baseline = resolveProjectLayout(linked, home);
    symlinkSync(join(root, "missing-plans"), join(linked, ".plans"));
    writeRegistry(home, {
      projects: {
        [alias]: { aligndev: { profile: "unprovisioned-profile" } },
        "~/gone": { aligndev: { profile: "work" } },
      },
    });
    const before = readdirSync(join(home, ".alignfirst", "companions"));
    const layout = resolveProjectLayout(linked, home);
    expect(layout.aligndev).toEqual({ profile: "unprovisioned-profile" });
    expect(resolveProjectLayout(project, home).aligndev).toEqual(layout.aligndev);
    expect(layout.companion).toBeNull();
    expect(layout.locations).toEqual({
      ...baseline.locations,
      ".plans": { path: join(linked, ".plans"), in: "project", exists: true },
      _aligndev: { path: join(linked, ".plans"), in: "project", exists: true },
    });
    expect(separateSessionTree(layout)).toBeUndefined();
    expect(sharedCompanionDirs(home)).toEqual([]);
    expect(nestedCompanionDirs(home)).toEqual([]);
    expect(strayRegistryKeys(home)).toEqual(["~/gone"]);
    expect(readdirSync(join(home, ".alignfirst", "companions"))).toEqual(before);
  });

  it("expands a ~/ key against the home directory and joins a relative dir to the companions", () => {
    const { home, project } = makeHome();
    writeRegistry(home, { projects: { "~/projects/app": { dir: "team/app" } } });
    const layout = resolveProjectLayout(project, home);
    expect(layout.companion).toEqual({
      dir: join(home, ".alignfirst", "companions", "team", "app"),
      exists: false,
      key: "~/projects/app",
      items: {
        ".alignfirst.json": "auto",
        ".alignfirst-instructions": "auto",
        "DEVELOPERS.md": "auto",
        docs: "auto",
        ".plans": "auto",
        _aligndev: "auto",
      },
    });
  });

  it("matches the main worktree from a linked worktree", () => {
    const { home, project } = makeHome();
    const linked = join(home, "worktrees", "app-feature");
    git(project, "worktree", "add", "--quiet", "-b", "feature", linked);
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "projects_app",
          items: { docs: "companion", ".plans": "project" },
          aligndev: { profile: "work" },
        },
      },
    });
    const layout = resolveProjectLayout(linked, home);
    expect(layout.aligndev).toEqual({ profile: "work" });
    expect(layout.companion?.dir).toBe(join(home, ".alignfirst", "companions", "projects_app"));
    expect(layout.locations.docs.path).toBe(
      join(home, ".alignfirst", "companions", "projects_app", "docs"),
    );
    expect(layout.locations[".plans"].path).toBe(join(linked, ".plans"));
  });

  it("matches the project's own key only, never an ancestor", () => {
    const { home, project } = makeHome();
    const ancestor = { dir: "projects", items: { docs: "companion" } };
    writeRegistry(home, { projects: { "~/projects": ancestor } });
    expect(resolveProjectLayout(project, home).companion).toBeNull();
    writeRegistry(home, {
      projects: {
        "~/projects": ancestor,
        [project]: { dir: "app", items: { ".plans": "project" } },
      },
    });
    const companion = resolveProjectLayout(project, home).companion;
    expect(companion?.key).toBe(project);
    expect(companion?.items).toMatchObject({ docs: "auto", ".plans": "project" });
  });

  it("matches a key through its real path and ignores a sibling prefix", () => {
    const { root, home, project } = makeHome();
    symlinkSync(join(home, "projects"), join(root, "linked-projects"));
    writeRegistry(home, { projects: { "~/projects/ap": { dir: "ap" } } });
    expect(resolveProjectLayout(project, home).companion).toBeNull();
    const key = join(root, "linked-projects", "app");
    writeRegistry(home, { projects: { [key]: { dir: "app" } } });
    expect(resolveProjectLayout(project, home).companion?.key).toBe(key);
  });

  it("resolves a ~/ dir against the real home directory", () => {
    const { root, home, project } = makeHome();
    const linkedHome = join(root, "linked-home");
    symlinkSync(home, linkedHome);
    writeRegistry(home, { projects: { "~/projects/app": { dir: "~/companions/app" } } });
    expect(resolveProjectLayout(project, linkedHome).companion?.dir).toBe(
      join(home, "companions", "app"),
    );
  });

  it("uses an absolute dir as written, and its real path when it exists", () => {
    const { root, home, project } = makeHome();
    const target = join(root, "srv", "app-companion");
    writeRegistry(home, { projects: { "~/projects/app": { dir: join(root, "link") } } });
    expect(resolveProjectLayout(project, home).companion?.dir).toBe(join(root, "link"));
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, "link"));
    expect(resolveProjectLayout(project, home).companion).toMatchObject({
      dir: target,
      exists: true,
    });
  });

  it("follows a symlinked companions directory, registry included", () => {
    const { root, home, project } = makeHome();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(home, ".alignfirst"));
    symlinkSync(elsewhere, join(home, ".alignfirst", "companions"));
    writeRegistry(home, { projects: { "~/projects/app": { dir: "projects_app" } } });
    expect(existsSync(join(elsewhere, "registry.json"))).toBe(true);
    expect(resolveProjectLayout(project, home).companion?.dir).toBe(
      join(elsewhere, "projects_app"),
    );
  });

  it("applies the resolution table", () => {
    const { home, project } = makeHome();
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "projects_app",
          items: {
            ".alignfirst.json": "companion",
            ".alignfirst-instructions": "project",
            "DEVELOPERS.md": "auto",
          },
        },
      },
    });
    mkdirSync(companion, { recursive: true });
    mkdirSync(join(companion, ".alignfirst-instructions"));
    writeFileSync(join(companion, "DEVELOPERS.md"), "companion\n");
    writeFileSync(join(project, "DEVELOPERS.md"), "project\n");
    mkdirSync(join(project, "docs"));
    const { locations } = resolveProjectLayout(project, home);
    expect(locations[".alignfirst.json"]).toEqual({
      path: join(companion, ".alignfirst.json"),
      in: "companion",
      exists: false,
    });
    expect(locations[".alignfirst-instructions"]).toEqual({
      path: join(project, ".alignfirst-instructions"),
      in: "project",
      exists: false,
    });
    expect(locations["DEVELOPERS.md"]).toEqual({
      path: join(companion, "DEVELOPERS.md"),
      in: "companion",
      exists: true,
    });
    expect(locations.docs).toEqual({ path: join(project, "docs"), in: "project", exists: true });
    expect(locations[".plans"]).toEqual({
      path: join(companion, ".plans"),
      in: "companion",
      exists: false,
    });
  });

  it("resolves _aligndev to the companion only when set to companion", () => {
    const { home, project } = makeHome();
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    writeRegistry(home, {
      projects: {
        "~/projects/app": {
          dir: "projects_app",
          items: { ".plans": "project", _aligndev: "companion" },
        },
      },
    });
    const separate = resolveProjectLayout(project, home).locations;
    expect(separate[".plans"].path).toBe(join(project, ".plans"));
    expect(separate._aligndev).toEqual({
      path: join(companion, ".plans"),
      in: "companion",
      exists: false,
    });

    writeRegistry(home, {
      projects: { "~/projects/app": { dir: "projects_app", items: { _aligndev: "auto" } } },
    });
    const shared = resolveProjectLayout(project, home).locations;
    expect(shared._aligndev).toEqual(shared[".plans"]);
  });

  it("rejects _aligndev on companion with an automatic .plans, naming the key", () => {
    const { home, project } = makeHome();
    writeRegistry(home, {
      projects: { "~/projects/app": { dir: "projects_app", items: { _aligndev: "companion" } } },
    });
    expect(() => resolveProjectLayout(project, home)).toThrow(
      '"_aligndev": "companion" requires ".plans" set to "companion" or "project" (key: ~/projects/app)',
    );
  });

  it("gives no companion to a bare repository or a directory outside git", () => {
    const { root, home } = makeHome();
    const bare = join(home, "projects", "bare.git");
    git(root, "init", "--quiet", "--bare", bare);
    const plain = join(home, "projects", "plain");
    mkdirSync(plain);
    writeRegistry(home, {
      projects: { "~/projects/bare.git": { dir: "bare" }, "~/projects/plain": { dir: "plain" } },
    });
    expect(resolveProjectLayout(bare, home).companion).toBeNull();
    expect(resolveProjectLayout(plain, home).companion).toBeNull();
  });
});

interface HomeFixture {
  root: string;
  home: string;
  project: string;
}

function makeHome(): HomeFixture {
  const root = makeTempDir("alignfirst-layout-");
  dirs.push(root);
  configureGit(root);
  const home = join(root, "home");
  const project = join(home, "projects", "app");
  initRepository(project);
  return { root, home, project };
}
