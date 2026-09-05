import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { main, parseAlcodeArgs } from "../src/cli.js";

const ALIGNFIRST_BIN = fileURLToPath(
  new URL("../../alignfirst/bin/alignfirst.mjs", import.meta.url),
);

let gitConfigDir: string;
let gitConfigPath: string;
let originalGitConfig: string | undefined;
const fixtureDirs: string[] = [];

beforeAll(() => {
  gitConfigDir = mkdtempSync(join(tmpdir(), "alcode-projects-git-"));
  gitConfigPath = join(gitConfigDir, "gitconfig");
  writeFileSync(gitConfigPath, "");
  originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
});

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  rmSync(gitConfigDir, { recursive: true, force: true });
});

describe("projects command surface", () => {
  it("dispatches tokens unchanged and renders help without a coding-agent selection", async () => {
    expect(parseAlcodeArgs(["node", "alcode", "projects", "list", "--json"])).toEqual({
      kind: "projects",
      tokens: ["list", "--json"],
    });
    const fixture = makeFixture();
    const result = await runProjects(fixture, ["--help"], { env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("alcode projects free-ports --size <n>");
  });

  it("requires a marker and expands --root ~/ against the injected home", async () => {
    const fixture = makeFixture();
    const projects = join(fixture.home, "projects");
    mkdirSync(projects);
    const result = await runProjects(fixture, ["list", "--root", "~/projects"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".alignfirst-projects.json is missing");
    expect(result.stderr).toContain("alcode projects init");
    expect(result.stderr).toContain("--root <path>");
  });

  it("prints the generic guide without a marker or alignfirst executable", async () => {
    const fixture = makeFixture();
    const result = await runProjects(fixture, ["--guide"], {
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# `alcode projects` guide");
    expect(result.stdout).toContain("setup guide writes the returned block as `portRange`");
  });

  it("initializes a marker, refuses overwrite, and validates its range", async () => {
    const fixture = makeFixture();
    const created = await runProjects(fixture, [
      "init",
      "--description",
      "Services",
      "--port-range",
      "8000-8099",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created");
    expect(readJson(join(fixture.root, ".alignfirst-projects.json"))).toEqual({
      description: "Services",
      portRange: { first: 8000, last: 8099 },
    });

    const duplicate = await runProjects(fixture, ["init"]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already exists");

    const other = makeFixture();
    const invalid = await runProjects(other, ["init", "--port-range", "9000-8000"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("must not exceed");
  });

  it("rejects unknown marker fields and names the marker file", async () => {
    const fixture = makeFixture({ unknown: true });
    const result = await runProjects(fixture, ["list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(join(fixture.root, ".alignfirst-projects.json"));
    expect(result.stderr).toContain("unknown");
  });

  it("validates command-specific options", async () => {
    const fixture = makeFixture();
    for (const args of [
      ["status"],
      ["list", "extra"],
      ["init", "--json"],
      ["list", "--size", "2"],
      ["free-ports"],
      ["--guide", "list"],
    ]) {
      expect((await runProjects(fixture, args)).code).toBe(1);
    }
  });
});

describe("project discovery", () => {
  it("discovers nested projects, portless projects, others, and cross-directory worktrees", async () => {
    const fixture = makeFixture({ description: "All projects", portRange: range(8000, 8999) });
    const alpha = makeRepository(fixture.root, "alpha", {
      portRange: range(8000, 8099),
    });
    const portless = makeRepository(fixture.root, "portless", {
      plans: { autoArchive: true },
    });
    const nested = makeProjectsDirectory(fixture.root, "nested", {
      description: "Nested",
      portRange: range(8500, 8599),
    });
    const beta = makeRepository(nested, "beta", { portRange: range(8500, 8549) });
    mkdirSync(join(nested, "notes"));
    addWorktree(alpha, join(nested, "alpha-workspace"), "feature");

    const result = await runProjects(fixture, ["list", "--json"], { env: {} });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.root).toBe(realpathSync(fixture.root));
    expect(report.directories).toEqual([
      {
        path: realpathSync(fixture.root),
        description: "All projects",
        portRange: range(8000, 8999),
        others: [],
      },
      {
        path: realpathSync(nested),
        description: "Nested",
        portRange: range(8500, 8599),
        others: ["notes"],
      },
    ]);
    expect(report.projects).toEqual([
      {
        name: "alpha",
        path: alpha,
        directory: realpathSync(fixture.root),
        portRange: range(8000, 8099),
        workspaces: ["alpha-workspace"],
      },
      {
        name: "beta",
        path: beta,
        directory: realpathSync(nested),
        portRange: range(8500, 8549),
        workspaces: [],
      },
      {
        name: "portless",
        path: portless,
        directory: realpathSync(fixture.root),
        portRange: null,
        workspaces: [],
      },
    ]);
    expect(report.issues).toEqual([]);
  });

  it("reports range, worktree, config, and overlap issues", async () => {
    const fixture = makeFixture({ portRange: range(8000, 8099) });
    makeRepository(fixture.root, "a", { portRange: range(8000, 8049) });
    makeRepository(fixture.root, "b", { portRange: range(8030, 8059) });
    makeRepository(fixture.root, "outside", { portRange: range(8200, 8299) });
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    const invalid = join(fixture.root, "invalid");
    mkdirSync(invalid);
    writeFileSync(join(invalid, ".alignfirst.json"), "{}\n");
    makeProjectsDirectory(fixture.root, "nested-outside", { portRange: range(9000, 9099) });
    const result = await runProjects(fixture, ["list", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    const messages = report.issues.map((issue: { message: string }) => issue.message);
    expect(messages).toContain("port range 8030..8059 overlaps a");
    expect(messages).toContain("port range 8200..8299 is outside enclosing range 8000..8099");
    expect(messages).toContain("port range 9000..9099 is outside enclosing range 8000..8099");
    expect(messages).toContain("not a git main worktree");
    expect(
      messages.some(
        (message: string) => message.startsWith("Invalid ") && message.includes(".alignfirst.json"),
      ),
    ).toBe(true);
    expect(report.projects.some((project: { name: string }) => project.name === "invalid")).toBe(
      false,
    );
  });

  it("fails the listing when alignfirst is missing", async () => {
    const fixture = makeFixture({});
    mkdirSync(join(fixture.root, "candidate"));
    const result = await runProjects(fixture, ["list"], {
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("alignfirst is not installed");
  });
});

describe("project status", () => {
  it("renders root project details and rejects a linked-worktree path", async () => {
    const fixture = makeFixture({ portRange: range(8000, 8999) });
    const project = makeRepository(fixture.root, "project", {
      ticketIdPattern: "^P-\\d+$",
      plans: { folder: "project-plans" },
      portRange: range(8000, 8099),
    });
    execGit(project, "remote", "add", "backup", "https://gitlab.com/team/project.git");
    execGit(project, "remote", "add", "origin", "git@github.com:team/project.git");
    const workspace = join(fixture.root, "project-workspace");
    addWorktree(project, workspace, "feature");

    const result = await runProjects(fixture, ["status", "project", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: "project",
      path: project,
      directory: realpathSync(fixture.root),
      remoteHost: "github.com",
      portRange: range(8000, 8099),
      plansFolder: "project-plans",
      ticketIdPattern: "^P-\\d+$",
      workspaces: ["project-workspace"],
      worktrees: [
        { branch: "main", name: "project", path: project },
        { branch: "feature", name: "project-workspace", path: realpathSync(workspace) },
      ],
    });

    const text = await runProjects(fixture, ["status", project]);
    expect(text.stdout).toContain("Project:\n");
    expect(text.stdout).toContain('  Remote host: "github.com"');
    expect(text.stdout).toContain("  Port range: 8000..8099");
    expect(text.stdout).toContain('  Ticket id pattern: "^P-\\\\d+$"');
    expect(text.stdout).not.toContain("Config source:");

    const rejected = await runProjects(fixture, ["status", workspace]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("is not a project of");
    expect(rejected.stderr).toContain("main-worktree path");
  });
});

describe("project ports and guide", () => {
  it("finds the lowest block around project and nested-directory claims", async () => {
    const fixture = makeFixture({ portRange: range(8000, 8099) });
    makeRepository(fixture.root, "allocated", { portRange: range(8000, 8009) });
    makeProjectsDirectory(fixture.root, "nested", { portRange: range(8020, 8029) });

    const text = await runProjects(fixture, ["free-ports", "--size", "10"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe("8010..8019\n");
    const json = await runProjects(fixture, ["free-ports", "--size", "10", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual(range(8010, 8019));

    const exhausted = await runProjects(fixture, ["free-ports", "--size", "80"]);
    expect(exhausted.code).toBe(1);
    expect(exhausted.stderr).toContain("No block of 80 contiguous free ports in 8000..8099");
  });

  it("requires a root port range for free-ports", async () => {
    const fixture = makeFixture({});
    const result = await runProjects(fixture, ["free-ports", "--size", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no portRange");
  });

  it("appends root and nested guide sections in path order", async () => {
    const fixture = makeFixture({ description: "Root projects", portRange: range(8000, 8999) });
    const z = makeProjectsDirectory(fixture.root, "z", {});
    const a = makeProjectsDirectory(fixture.root, "a", { portRange: range(8100, 8199) });
    const result = await runProjects(fixture, ["--guide"]);
    expect(result.code).toBe(0);
    const rootHeading = result.stdout.indexOf(`## ${realpathSync(fixture.root)}`);
    const aHeading = result.stdout.indexOf(`## ${realpathSync(a)}`);
    const zHeading = result.stdout.indexOf(`## ${realpathSync(z)}`);
    expect(rootHeading).toBeGreaterThan(0);
    expect(rootHeading).toBeLessThan(aHeading);
    expect(aHeading).toBeLessThan(zHeading);
    expect(result.stdout).toContain("Root projects");
    expect(result.stdout).toContain("Port range: 8100..8199");
  });
});

interface Fixture {
  base: string;
  root: string;
  home: string;
}

interface RunOverrides {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  alignfirstCommand?: string[];
}

function makeFixture(marker?: object): Fixture {
  const base = mkdtempSync(join(tmpdir(), "alcode-projects-"));
  fixtureDirs.push(base);
  const root = join(base, "projects");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  if (marker !== undefined) writeMarker(root, marker);
  return { base, root, home };
}

async function runProjects(
  fixture: Fixture,
  args: string[],
  overrides: RunOverrides = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = makeSink();
  const stderr = makeSink();
  const env = { ...process.env };
  delete env.ALIGNFIRST_CODE_AGENT;
  Object.assign(env, overrides.env);
  const code = await main({
    argv: ["node", "alcode", "projects", ...args],
    cwd: overrides.cwd ?? fixture.root,
    home: overrides.home ?? fixture.home,
    env: { ...env, GIT_CONFIG_GLOBAL: gitConfigPath },
    alignfirstCommand: overrides.alignfirstCommand ?? ["node", ALIGNFIRST_BIN],
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function makeProjectsDirectory(parent: string, name: string, marker: object): string {
  const directory = join(parent, name);
  mkdirSync(directory);
  writeMarker(directory, marker);
  return directory;
}

function makeRepository(parent: string, name: string, config?: object): string {
  const repository = join(parent, name);
  execGit(parent, "init", "--quiet", "--initial-branch=main", repository);
  execGit(repository, "config", "user.name", "Test");
  execGit(repository, "config", "user.email", "test@example.com");
  writeFileSync(join(repository, "README.md"), `${name}\n`);
  execGit(repository, "add", "README.md");
  execGit(repository, "commit", "--quiet", "-m", "initial");
  if (config !== undefined) writeProjectConfig(repository, config);
  return realpathSync(repository);
}

function writeProjectConfig(directory: string, config: object): void {
  writeFileSync(
    join(directory, ".alignfirst.json"),
    `${JSON.stringify({ schemaVersion: 1, ...config }, undefined, 2)}\n`,
  );
}

function addWorktree(main: string, worktree: string, branch: string): void {
  execGit(main, "worktree", "add", "--quiet", "-b", branch, worktree);
}

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
  }).trim();
}

function writeMarker(directory: string, marker: object): void {
  writeFileSync(
    join(directory, ".alignfirst-projects.json"),
    `${JSON.stringify(marker, undefined, 2)}\n`,
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function range(first: number, last: number): { first: number; last: number } {
  return { first, last };
}

function makeSink(): { write(text: string): void; text(): string } {
  let buffer = "";
  return {
    write(text) {
      buffer += text;
    },
    text: () => buffer,
  };
}
