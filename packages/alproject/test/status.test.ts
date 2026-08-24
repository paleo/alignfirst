import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AlprojectConfig } from "../src/config.js";
import type { Registry } from "../src/registry.js";
import { getProjectStatus } from "../src/status.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("getProjectStatus", () => {
  it("reports registration, ports, the preferred remote host, and every worktree", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    const workspace = join(fixture.root, "project-workspace");
    execGit(project, "worktree", "add", "--quiet", "-b", "feature", workspace);
    execGit(project, "remote", "add", "backup", "https://gitlab.com/team/project.git");
    execGit(project, "remote", "add", "origin", "git@github.com:team/project.git");
    const registry: Registry = {
      projects: [
        {
          path: project,
          ports: { basePort: 8000, maxWorkspaces: 3, portsPerWorkspace: 4 },
        },
      ],
      version: 1,
    };

    expect(getProjectStatus(fixture.config, registry, "project")).toEqual({
      name: "project",
      path: project,
      ports: { basePort: 8000, endPort: 8011, maxWorkspaces: 3, portsPerWorkspace: 4 },
      remoteHost: "github.com",
      status: "registered",
      worktrees: [
        { branch: "main", name: "project", path: project },
        {
          branch: "feature",
          name: "project-workspace",
          path: realpathSync(workspace),
        },
      ],
    });
  });

  it("reports explicit absent values for an unregistered project", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");

    expect(getProjectStatus(fixture.config, emptyRegistry(), project)).toEqual({
      name: "project",
      path: project,
      ports: null,
      remoteHost: null,
      status: "unregistered",
      worktrees: [{ branch: "main", name: "project", path: project }],
    });
  });

  it("falls back to another remote with a recognizable host", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    execGit(project, "remote", "add", "origin", join(fixture.root, "local.git"));
    execGit(project, "remote", "add", "backup", "ssh://git@gitlab.com/team/project.git");

    expect(getProjectStatus(fixture.config, emptyRegistry(), project).remoteHost).toBe(
      "gitlab.com",
    );
  });

  it("does not treat a hostless URL scheme as an SCP host", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    execGit(project, "remote", "add", "origin", "file:///srv/project.git");
    execGit(project, "remote", "add", "backup", "https://gitlab.com/team/project.git");

    expect(getProjectStatus(fixture.config, emptyRegistry(), project).remoteHost).toBe(
      "gitlab.com",
    );
  });

  it("reads a remote whose name starts with a hyphen", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    execGit(project, "remote", "add", "--", "--push", "https://github.com/team/project.git");

    expect(getProjectStatus(fixture.config, emptyRegistry(), project).remoteHost).toBe(
      "github.com",
    );
  });

  it("reads the host from SCP syntax without a user", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    execGit(project, "remote", "add", "origin", "github.com:team/project.git");

    expect(getProjectStatus(fixture.config, emptyRegistry(), project).remoteHost).toBe(
      "github.com",
    );
  });

  it("reports a registered project missing from the filesystem", () => {
    const fixture = makeFixture();
    const project = join(fixture.root, "missing");
    const registry: Registry = { projects: [{ path: project }], version: 1 };

    expect(getProjectStatus(fixture.config, registry, "missing")).toEqual({
      name: "missing",
      path: project,
      ports: null,
      remoteHost: null,
      status: "missing",
      worktrees: [],
    });
  });

  it("inspects a registered project whose parent is no longer configured", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    const configuredParent = join(fixture.root, "other-parent");
    mkdirSync(configuredParent);
    fixture.config.projectParents = [{ path: configuredParent }];
    execGit(project, "remote", "add", "origin", "https://github.com/team/project.git");
    const registry: Registry = { projects: [{ path: project }], version: 1 };

    expect(getProjectStatus(fixture.config, registry, project)).toMatchObject({
      path: project,
      remoteHost: "github.com",
      status: "registered",
      worktrees: [{ branch: "main", name: "project", path: project }],
    });
  });

  it("rejects an unregistered project outside configured parents", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    const configuredParent = join(fixture.root, "other-parent");
    mkdirSync(configuredParent);
    fixture.config.projectParents = [{ path: configuredParent }];

    expect(() => getProjectStatus(fixture.config, emptyRegistry(), project)).toThrow(
      /neither registered nor discovered/,
    );
  });

  it("rejects unknown and linked-worktree paths with main-worktree guidance", () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    const workspace = join(fixture.root, "workspace");
    execGit(project, "worktree", "add", "--quiet", "-b", "feature", workspace);
    mkdirSync(join(fixture.root, "directory"));

    expect(() => getProjectStatus(fixture.config, emptyRegistry(), "directory")).toThrow(
      /canonical main-worktree path/,
    );
    expect(() => getProjectStatus(fixture.config, emptyRegistry(), workspace)).toThrow(
      /canonical main-worktree path/,
    );
  });
});

interface Fixture {
  config: AlprojectConfig;
  root: string;
}

function makeFixture(): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-status-"));
  const root = join(fixtureDir, "root");
  mkdirSync(root);
  return {
    config: {
      configPath: join(fixtureDir, ".alproject.json"),
      projectParents: [{ path: root }],
      root: { path: root, portRange: { first: 8000, last: 9000 } },
    },
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

function emptyRegistry(): Registry {
  return { projects: [], version: 1 };
}

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
