import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AlprojectConfig } from "../src/config.js";
import { buildProjectList, discoverProjects } from "../src/discovery.js";
import type { Registry } from "../src/registry.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("discoverProjects", () => {
  it("discovers only direct-child main worktrees", () => {
    const fixture = makeFixture();
    const direct = makeRepository(fixture.parentA, "direct");
    const container = join(fixture.parentA, "container");
    mkdirSync(container);
    makeRepository(container, "nested");

    expect(discoverProjects(fixture.config)).toEqual({
      additionalDirectories: [{ directories: ["container"], parent: fixture.parentA }],
      projects: [projectRecord(direct)],
    });
  });

  it("associates Git-created linked worktrees through both metadata sides", () => {
    const fixture = makeFixture();
    const main = makeRepository(fixture.parentA, "project");
    addWorktree(main, join(fixture.parentA, "z-workspace"), "z-branch");
    addWorktree(main, join(fixture.parentA, "a-workspace"), "a-branch");

    expect(discoverProjects(fixture.config)).toEqual({
      additionalDirectories: [],
      projects: [projectRecord(main, ["a-workspace", "z-workspace"])],
    });
  });

  it("classifies malformed and one-sided Git relationships as additional directories", () => {
    const fixture = makeFixture();
    const main = makeRepository(fixture.parentA, "project");
    const malformed = makeDirectory(fixture.parentA, "malformed");
    writeFileSync(join(malformed, ".git"), "not git metadata\n");
    const missingBacklink = join(fixture.parentA, "missing-backlink");
    addWorktree(main, missingBacklink, "missing-backlink");
    const metadataDirectory = gitMetadataDirectory(missingBacklink);
    writeFileSync(join(metadataDirectory, "gitdir"), join(fixture.parentA, "elsewhere", ".git"));

    expect(discoverProjects(fixture.config)).toEqual({
      additionalDirectories: [
        {
          directories: ["malformed", "missing-backlink"],
          parent: fixture.parentA,
        },
      ],
      projects: [projectRecord(main)],
    });
  });

  it("rejects metadata outside the main repository worktrees area", () => {
    const fixture = makeFixture();
    const main = makeRepository(fixture.parentA, "project");
    const candidate = makeDirectory(fixture.parentA, "candidate");
    const fakeMetadata = join(main, ".git", "fake-metadata");
    mkdirSync(fakeMetadata);
    writeFileSync(join(candidate, ".git"), `gitdir: ${fakeMetadata}\n`);
    writeFileSync(join(fakeMetadata, "commondir"), "..\n");
    writeFileSync(join(fakeMetadata, "gitdir"), join(candidate, ".git"));

    expect(discoverProjects(fixture.config).additionalDirectories).toEqual([
      { directories: ["candidate"], parent: fixture.parentA },
    ]);
  });

  it("leaves a valid worktree additional when its main is outside allowed parents", () => {
    const fixture = makeFixture();
    const externalParent = join(fixture.root, "external");
    mkdirSync(externalParent);
    const externalMain = makeRepository(externalParent, "project");
    addWorktree(externalMain, join(fixture.parentA, "external-workspace"), "external-branch");

    expect(discoverProjects(fixture.config)).toEqual({
      additionalDirectories: [{ directories: ["external-workspace"], parent: fixture.parentA }],
      projects: [],
    });
  });

  it("keeps duplicate project names distinct and orders every collection", () => {
    const fixture = makeFixture(["parentB", "parentA"]);
    const projectB = makeRepository(fixture.parentB, "same");
    const projectA = makeRepository(fixture.parentA, "same");
    makeDirectory(fixture.parentB, "z-extra");
    makeDirectory(fixture.parentB, "a-extra");
    makeDirectory(fixture.parentA, "middle");

    expect(discoverProjects(fixture.config)).toEqual({
      additionalDirectories: [
        { directories: ["middle"], parent: fixture.parentA },
        { directories: ["a-extra", "z-extra"], parent: fixture.parentB },
      ],
      projects: [projectRecord(projectA), projectRecord(projectB)],
    });
  });
});

describe("buildProjectList", () => {
  it("merges registered, unregistered, and missing projects without writing", () => {
    const fixture = makeFixture();
    const registered = makeRepository(fixture.parentA, "registered");
    const unregistered = makeRepository(fixture.parentA, "unregistered");
    const missing = join(fixture.parentB, "missing");
    makeDirectory(fixture.parentB, "additional");
    const registry: Registry = {
      projects: [
        {
          path: registered,
          ports: { basePort: 8000, maxWorkspaces: 2, portsPerWorkspace: 10 },
        },
        { path: missing },
      ],
      schemaVersion: 2,
    };
    const registryPath = join(fixture.root, "alproject-registry.json");
    writeFileSync(registryPath, `${JSON.stringify(registry, undefined, 2)}\n`);
    const before = readFileSync(registryPath, "utf8");

    expect(buildProjectList(fixture.config, registry)).toEqual({
      additionalDirectories: [{ directories: ["additional"], parent: fixture.parentB }],
      projects: [
        {
          ...projectRecord(registered),
          ports: {
            basePort: 8000,
            endPort: 8019,
            maxWorkspaces: 2,
            portsPerWorkspace: 10,
          },
          status: "registered",
        },
        { ...projectRecord(unregistered), status: "unregistered" },
        {
          name: "missing",
          parent: fixture.parentB,
          path: missing,
          status: "missing",
          workspaces: [],
        },
      ],
    });
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("reports a moved project as one missing and one unregistered record", () => {
    const fixture = makeFixture();
    const original = makeRepository(fixture.parentA, "original");
    const registry: Registry = { projects: [{ path: original }], schemaVersion: 2 };
    const moved = join(fixture.parentA, "moved");
    renameSync(original, moved);

    expect(buildProjectList(fixture.config, registry).projects).toEqual([
      { ...projectRecord(moved), status: "unregistered" },
      {
        name: "original",
        parent: fixture.parentA,
        path: original,
        status: "missing",
        workspaces: [],
      },
    ]);
  });
});

interface Fixture {
  config: AlprojectConfig;
  parentA: string;
  parentB: string;
  root: string;
}

function makeFixture(parentOrder = ["parentA", "parentB"]): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-discovery-"));
  const root = join(fixtureDir, "root");
  const parentA = join(fixtureDir, "parentA");
  const parentB = join(fixtureDir, "parentB");
  mkdirSync(root);
  mkdirSync(parentA);
  mkdirSync(parentB);
  const parents = { parentA, parentB };
  return {
    config: {
      configPath: join(fixtureDir, ".alproject.json"),
      projectParents: parentOrder.map((name) => ({
        path: parents[name as keyof typeof parents],
      })),
      root: { path: root, portRange: { first: 8000, last: 9000 } },
    },
    parentA,
    parentB,
    root,
  };
}

function makeRepository(parent: string, name: string): string {
  const repository = join(parent, name);
  execGit(parent, "init", "--quiet", "--initial-branch=main", repository);
  execGit(repository, "config", "user.name", "Test");
  execGit(repository, "config", "user.email", "test@example.com");
  writeFileSync(join(repository, "README.md"), `${name}\n`);
  execGit(repository, "add", "README.md");
  execGit(repository, "commit", "--quiet", "-m", "initial");
  return realpathSync(repository);
}

function addWorktree(main: string, worktree: string, branch: string): void {
  execGit(main, "worktree", "add", "--quiet", "-b", branch, worktree);
}

function gitMetadataDirectory(worktree: string): string {
  const gitFile = readFileSync(join(worktree, ".git"), "utf8");
  return gitFile.replace(/^gitdir:\s*/u, "").trim();
}

function makeDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  mkdirSync(directory);
  return directory;
}

function projectRecord(path: string, workspaces: string[] = []) {
  return {
    name: basename(path),
    parent: dirname(path),
    path,
    workspaces,
  };
}

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
