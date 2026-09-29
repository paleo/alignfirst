import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companionsPath, resolveProjectLayout } from "../src/project-layout.js";
import { configureGit, git, initRepository, makeTempDir, writeCompanions } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project layout", () => {
  it("resolves every item in the project without companions.json", () => {
    const { home, project } = makeHome();
    const layout = resolveProjectLayout(project, home);
    expect(layout.companion).toBeNull();
    expect(layout.locations[".plans"]).toEqual({
      path: join(project, ".plans"),
      in: "project",
      exists: false,
    });
    expect(layout.locations._aldev).toEqual(layout.locations[".plans"]);
  });

  it.each([
    ["{", "JSON"],
    [JSON.stringify({ paths: {} }), "root"],
    [JSON.stringify({ root: "", paths: {} }), "root must be non-empty"],
    [JSON.stringify({ root: "~/c", paths: {}, extra: 1 }), "extra must be removed"],
    [JSON.stringify({ root: "~/c", paths: { "~/p": { other: true } } }), "other must be removed"],
    [JSON.stringify({ root: "~/c", paths: { "~/p": { docs: "yes" } } }), "docs"],
    [JSON.stringify({ root: "c", paths: {} }), "root must be an absolute path"],
    [JSON.stringify({ root: "~/c", paths: { "/a": {}, "p/q": {} } }), "paths key must be"],
    [JSON.stringify({ root: "~/c", paths: { "~p": {} } }), "paths key must be"],
  ])("rejects an invalid file %#", (content, message) => {
    const { home, project } = makeHome();
    mkdirSync(join(home, ".config", "alignfirst"), { recursive: true });
    writeFileSync(companionsPath(home), content);
    expect(() => resolveProjectLayout(project, home)).toThrow(`Invalid ${companionsPath(home)}: `);
    expect(() => resolveProjectLayout(project, home)).toThrow(message);
  });

  it("expands ~ and ~/ against the home directory and names the companion", () => {
    const { home, project } = makeHome();
    writeCompanions(home, { root: "~/companions", paths: { "~": {} } });
    const layout = resolveProjectLayout(project, home);
    expect(layout.companion).toEqual({
      dir: join(home, "companions", "projects_app"),
      exists: false,
      entries: ["~"],
      flags: {
        ".alignfirst.json": "auto",
        ".alignfirst.md": "auto",
        "DEVELOPERS.md": "auto",
        docs: "auto",
        ".plans": "auto",
        _aldev: "auto",
      },
    });
  });

  it("matches the main worktree from a linked worktree", () => {
    const { home, project } = makeHome();
    const linked = join(home, "worktrees", "app-feature");
    git(project, "worktree", "add", "--quiet", "-b", "feature", linked);
    writeCompanions(home, {
      root: "~/companions",
      paths: { "~/projects/app": { docs: true, ".plans": false } },
    });
    const layout = resolveProjectLayout(linked, home);
    expect(layout.companion?.dir).toBe(join(home, "companions", "projects_app"));
    expect(layout.locations.docs.path).toBe(join(home, "companions", "projects_app", "docs"));
    expect(layout.locations[".plans"].path).toBe(join(linked, ".plans"));
  });

  it("merges flags item by item, the most specific key first", () => {
    const { home, project } = makeHome();
    writeCompanions(home, {
      root: "~/companions",
      paths: {
        "~/projects": { docs: true, ".plans": true },
        [project]: { ".plans": false },
        "~/projects/ap": { "DEVELOPERS.md": true },
      },
    });
    const companion = resolveProjectLayout(project, home).companion;
    expect(companion?.entries).toEqual([project, "~/projects"]);
    expect(companion?.flags).toMatchObject({
      docs: true,
      ".plans": false,
      "DEVELOPERS.md": "auto",
    });
  });

  it("matches a key through its real path and ignores a sibling prefix", () => {
    const { root, home, project } = makeHome();
    symlinkSync(join(home, "projects"), join(root, "linked-projects"));
    writeCompanions(home, { root: "~/companions", paths: { "~/projects/ap": {} } });
    expect(resolveProjectLayout(project, home).companion).toBeNull();
    writeCompanions(home, { root: "~/companions", paths: { [join(root, "linked-projects")]: {} } });
    expect(resolveProjectLayout(project, home).companion?.entries).toEqual([
      join(root, "linked-projects"),
    ]);
  });

  it("names a companion outside the home directory by its absolute path", () => {
    const { root, home } = makeHome();
    const outside = join(root, "srv", "api");
    initRepository(outside);
    writeCompanions(home, { root: join(root, "companions"), paths: { [outside]: {} } });
    expect(resolveProjectLayout(outside, home).companion?.dir).toBe(
      join(root, "companions", outside.slice(1).replaceAll("/", "_")),
    );
  });

  it("applies the resolution table", () => {
    const { home, project } = makeHome();
    const companion = join(home, "companions", "projects_app");
    writeCompanions(home, {
      root: "~/companions",
      paths: {
        "~/projects/app": {
          ".alignfirst.json": true,
          ".alignfirst.md": false,
          "DEVELOPERS.md": "auto",
        },
      },
    });
    mkdirSync(companion, { recursive: true });
    for (const name of [".alignfirst.md", "DEVELOPERS.md"])
      writeFileSync(join(companion, name), "companion\n");
    writeFileSync(join(project, "DEVELOPERS.md"), "project\n");
    mkdirSync(join(project, "docs"));
    const { locations } = resolveProjectLayout(project, home);
    expect(locations[".alignfirst.json"]).toEqual({
      path: join(companion, ".alignfirst.json"),
      in: "companion",
      exists: false,
    });
    expect(locations[".alignfirst.md"]).toEqual({
      path: join(project, ".alignfirst.md"),
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

  it("resolves _aldev to the companion only when flagged true", () => {
    const { home, project } = makeHome();
    const companion = join(home, "companions", "projects_app");
    writeCompanions(home, {
      root: "~/companions",
      paths: { "~/projects/app": { ".plans": false, _aldev: true } },
    });
    const separate = resolveProjectLayout(project, home).locations;
    expect(separate[".plans"].path).toBe(join(project, ".plans"));
    expect(separate._aldev).toEqual({
      path: join(companion, ".plans"),
      in: "companion",
      exists: false,
    });

    writeCompanions(home, { root: "~/companions", paths: { "~/projects/app": { _aldev: false } } });
    const shared = resolveProjectLayout(project, home).locations;
    expect(shared._aldev).toEqual(shared[".plans"]);
  });

  it("rejects _aldev true with an automatic .plans, naming the matching keys", () => {
    const { home, project } = makeHome();
    writeCompanions(home, {
      root: "~/companions",
      paths: { "~/projects": {}, "~/projects/app": { _aldev: true } },
    });
    expect(() => resolveProjectLayout(project, home)).toThrow(
      '"_aldev": true requires ".plans" set to true or false (matching keys: ~/projects/app, ~/projects)',
    );
  });

  it("gives no companion to a bare repository or a directory outside git", () => {
    const { root, home } = makeHome();
    const bare = join(home, "projects", "bare.git");
    git(root, "init", "--quiet", "--bare", bare);
    const plain = join(home, "projects", "plain");
    mkdirSync(plain);
    writeCompanions(home, { root: "~/companions", paths: { "~": {} } });
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
