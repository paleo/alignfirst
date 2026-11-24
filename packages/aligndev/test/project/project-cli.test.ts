import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeConfig, writeRegistry, writeSettings } from "../helpers.js";
import {
  addWorktree,
  execGit,
  type Fixture,
  makeFixture,
  makeRepository,
  type RunOverrides,
  type RunResult,
  range,
  runAligndev,
  useProjectFixtures,
  writeProjectConfig,
} from "./fixtures.js";

useProjectFixtures();

describe("projects command surface", () => {
  it("keeps stale Git registrations readable with the existing project JSON shape", async () => {
    const fixture = makeFixture();
    const repo = makeRepository(fixture.root, "app");
    const stale = join(fixture.base, "stale");
    addWorktree(repo, stale, "stale");
    rmSync(stale, { recursive: true });
    const result = await runProjects(fixture, ["status", repo, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).worktrees).toEqual([
      { path: repo, name: "app", branch: "main" },
      { path: stale, name: "stale", branch: "stale" },
    ]);
  });

  it("scans any directory as a root and expands --root ~/ against the injected home", async () => {
    const fixture = makeFixture();
    const projects = join(fixture.home, "projects");
    mkdirSync(projects);
    const app = makeRepository(projects, "app");
    const result = await runProjects(fixture, ["list", "--json", "--root", "~/projects"]);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.root).toBe(realpathSync(projects));
    expect(report.projects.map(({ path }: { path: string }) => path)).toEqual([app]);
  });

  it("fails on a missing root", async () => {
    const fixture = makeFixture();
    const result = await runProjects(fixture, ["list", "--root", join(fixture.base, "missing")]);
    expect(result.code).toBe(1);
  });

  it("defaults --root to projectsRoot in the config, and lets --root override it", async () => {
    const fixture = makeFixture();
    makeRepository(fixture.root, "configured", {});
    const other = join(fixture.base, "other");
    mkdirSync(other);
    const cwd = join(fixture.base, "elsewhere");
    mkdirSync(cwd);
    writeConfig(fixture.home, {
      code: { harness: "claude" },
      projectsRoot: fixture.root,
    });

    const configured = await runProjects(fixture, ["list", "--json"], { cwd });
    expect(configured.code).toBe(0);
    expect(JSON.parse(configured.stdout).root).toBe(realpathSync(fixture.root));

    const overridden = await runProjects(fixture, ["list", "--json", "--root", other], { cwd });
    expect(overridden.code).toBe(0);
    expect(JSON.parse(overridden.stdout).root).toBe(realpathSync(other));
  });

  it("expands a ~/ projectsRoot against the injected home", async () => {
    const fixture = makeFixture();
    const projects = join(fixture.home, "projects");
    mkdirSync(projects);
    writeConfig(fixture.home, {
      code: { harness: "claude" },
      projectsRoot: "~/projects",
    });

    const result = await runProjects(fixture, ["list", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).root).toBe(realpathSync(projects));
  });

  it.each([
    [["status"], "status requires exactly one path"],
    [["list", "extra"], "list does not accept a path"],
    [["doctor", "--json"], "--json is valid only with"],
    [["list", "--size", "2"], "--size is valid only with free-ports"],
    [["free-ports"], "free-ports requires --size"],
    [["list", "--max-depth", "0"], "--max-depth must be a positive integer"],
    [["doctor", "--max-depth", "two"], "--max-depth must be a positive integer"],
    [["--max-depth", "2"], "Command options require a projects command"],
    [["--guide"], "Unknown option '--guide'"],
    [["init"], "Unknown projects command: init"],
    [["free-ports", "--size", "1", "--range", "web"], "Unknown option '--range'"],
    [["list", "--description", "x"], "Unknown option '--description'"],
    [["list", "--port-range", "8000-8099"], "Unknown option '--port-range'"],
  ])("rejects the option misuse %j", async (args) => {
    const result = await runProjects(makeFixture(), args);
    expect(result.code).toBe(1);
  });
});

describe("project inventory doctor", () => {
  it("reports a clean inventory", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8099) });
    makeRepository(fixture.root, "healthy", { portRange: range(8000, 8049) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(0);
  });

  it("reports every overlapping pair with both project paths and ranges", async () => {
    const fixture = makeFixture();
    const alpha = makeRepository(fixture.root, "alpha", { portRange: range(8000, 8050) });
    const beta = makeRepository(fixture.root, "beta", { portRange: range(8020, 8070) });
    const gamma = makeRepository(fixture.root, "gamma", { portRange: range(8040, 8090) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const [left, leftRange, right, rightRange] of [
      [alpha, "8000..8050", beta, "8020..8070"],
      [alpha, "8000..8050", gamma, "8040..8090"],
      [beta, "8020..8070", gamma, "8040..8090"],
    ]) {
      expect(
        lines.filter((line) =>
          [left, leftRange, right, rightRange].every((value) => line.includes(value)),
        ),
      ).toHaveLength(1);
    }
  });

  it("compares project ranges across groups", async () => {
    const fixture = makeFixture();
    const web = join(fixture.root, "web");
    const tools = join(fixture.root, "tools");
    mkdirSync(web);
    mkdirSync(tools);
    const left = makeRepository(web, "app", { portRange: range(8000, 8019) });
    const right = makeRepository(tools, "app", { portRange: range(8010, 8029) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(left);
    expect(result.stdout).toContain(right);
  });

  it("reports a project range outside portRange", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8099) });
    makeRepository(fixture.root, "inside", { portRange: range(8000, 8009) });
    const straddling = makeRepository(fixture.root, "straddling", {
      portRange: range(8090, 8109),
    });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain(straddling);
  });

  it("mentions skipped directories without failing", async () => {
    const fixture = makeFixture();
    const app = makeRepository(fixture.base, "app");
    const link = join(fixture.root, "linked-app");
    symlinkSync(app, link);

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(link);
  });

  it("rejects the retired project CLI range instead of silently ignoring it", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project", { cli: ">=99.0.0" });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(project);
  });

  it("fails for invalid configuration and incomplete discovery", async () => {
    const fixture = makeFixture();
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    const invalid = makeRepository(fixture.root, "invalid");
    writeFileSync(join(invalid, "alignfirst.json"), "{}\n");

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(invalid);
    expect(result.stdout).toContain(nongit);
  });

  it("renders a failed scan as a failing health line", async () => {
    const fixture = makeFixture();

    const result = await runProjects(fixture, ["doctor", "--root", join(fixture.base, "missing")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toBe("");
  });
});

describe("project discovery", () => {
  it("returns the list JSON shape", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8999) });
    const group = join(fixture.root, "group");
    mkdirSync(group);
    const app = makeRepository(group, "app", { portRange: range(8000, 8099) });
    const link = join(fixture.root, "link");
    symlinkSync(group, link);

    const result = await runProjects(fixture, ["list", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      root: realpathSync(fixture.root),
      portRange: range(8000, 8999),
      projects: [
        {
          name: "app",
          path: app,
          directory: group,
          portRange: range(8000, 8099),
          companion: null,
          aligndev: null,
          locations: expect.any(Object),
          workspaces: [],
        },
      ],
      skippedDirectories: [{ path: link, reason: "symlink" }],
      issues: [],
    });
  });

  it("reports a null portRange without the setting", async () => {
    const fixture = makeFixture();
    const result = await runProjects(fixture, ["list", "--json"]);
    expect(JSON.parse(result.stdout).portRange).toBeNull();
  });

  it("finds projects nested in groups, with their parent directory", async () => {
    const fixture = makeFixture();
    const inner = join(fixture.root, "clients", "acme");
    mkdirSync(inner, { recursive: true });
    const nested = makeRepository(inner, "site");
    const direct = makeRepository(fixture.root, "tool");

    const report = await listJson(fixture);

    expect(report.projects.map(({ path, directory }: Project) => [path, directory])).toEqual([
      [nested, inner],
      [direct, realpathSync(fixture.root)],
    ]);
  });

  it("finds a project at the depth limit and skips a group there", async () => {
    const fixture = makeFixture();
    const group = join(fixture.root, "group");
    mkdirSync(group);
    const project = makeRepository(group, "app");
    const deep = join(group, "deeper");
    mkdirSync(deep);
    makeRepository(deep, "hidden-by-depth");

    const report = await listJson(fixture, ["--max-depth", "2"]);

    expect(report.projects.map(({ path }: Project) => path)).toEqual([project]);
    expect(report.skippedDirectories).toEqual([{ path: deep, reason: "maxDepth" }]);
  });

  it("skips hidden directories and node_modules silently", async () => {
    const fixture = makeFixture();
    for (const name of [".cache", "node_modules"]) {
      mkdirSync(join(fixture.root, name));
      makeRepository(join(fixture.root, name), "app");
    }

    const report = await listJson(fixture);

    expect(report.projects).toEqual([]);
    expect(report.skippedDirectories).toEqual([]);
  });

  it("skips a symlinked directory and ignores links to files and broken links", async () => {
    const fixture = makeFixture();
    const target = join(fixture.base, "target");
    mkdirSync(target);
    makeRepository(target, "app");
    writeFileSync(join(fixture.base, "file"), "");
    symlinkSync(target, join(fixture.root, "directory-link"));
    symlinkSync(join(fixture.base, "file"), join(fixture.root, "file-link"));
    symlinkSync(join(fixture.base, "absent"), join(fixture.root, "broken-link"));

    const report = await listJson(fixture);

    expect(report.projects).toEqual([]);
    expect(report.skippedDirectories).toEqual([
      { path: join(realpathSync(fixture.root), "directory-link"), reason: "symlink" },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("skips an unreadable group", async () => {
    const fixture = makeFixture();
    const locked = join(fixture.root, "locked");
    mkdirSync(locked);
    makeRepository(locked, "app");
    chmodSync(locked, 0o000);
    try {
      const report = await listJson(fixture);
      expect(report.projects).toEqual([]);
      expect(report.skippedDirectories).toEqual([
        { path: join(realpathSync(fixture.root), "locked"), reason: "unreadable" },
      ]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("attaches a linked worktree across groups and skips one outside the scan", async () => {
    const fixture = makeFixture();
    const mains = join(fixture.root, "mains");
    const workspaces = join(fixture.root, "workspaces");
    mkdirSync(mains);
    mkdirSync(workspaces);
    const app = makeRepository(mains, "app");
    addWorktree(app, join(workspaces, "app-feature"), "feature");
    const outside = makeRepository(fixture.base, "outside");
    addWorktree(outside, join(workspaces, "outside-feature"), "feature");

    const report = await listJson(fixture);

    expect(report.projects.map(({ path, workspaces }: Project) => [path, workspaces])).toEqual([
      [app, ["app-feature"]],
    ]);
    expect(report.skippedDirectories).toEqual([
      { path: join(workspaces, "outside-feature"), reason: "outsideWorktree" },
    ]);
  });

  it("reports a configuration file outside Git and still scans that directory", async () => {
    const fixture = makeFixture();
    const group = join(fixture.root, "group");
    mkdirSync(group);
    writeProjectConfig(group, {});
    const app = makeRepository(group, "app");

    const report = await listJson(fixture);

    expect(report.projects.map(({ path }: Project) => path)).toEqual([app]);
    expect(report.issues.map(({ path }: { path: string }) => path)).toEqual([group]);
  });

  it("reports range, config, and overlap issues sorted by path", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8099) });
    makeRepository(fixture.root, "a", { portRange: range(8000, 8049) });
    makeRepository(fixture.root, "b", { portRange: range(8030, 8059) });
    makeRepository(fixture.root, "outside", { portRange: range(8200, 8299) });
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    const invalid = makeRepository(fixture.root, "invalid");
    writeFileSync(join(invalid, "alignfirst.json"), "{}\n");

    const report = await listJson(fixture);

    expect(report.issues.map((issue: { path: string }) => issue.path)).toEqual([
      join(fixture.root, "b"),
      invalid,
      nongit,
      join(fixture.root, "outside"),
    ]);
    expect(report.projects.some((project: Project) => project.name === "invalid")).toBe(false);
  });

  it("reports a project whose alignfirst is too old as an issue", async () => {
    const fixture = makeFixture();
    const old = makeRepository(fixture.root, "old");
    const report = JSON.stringify({ source: null, cli: null, config: null, locations: {} });
    const result = await runProjects(fixture, ["list", "--json"], {
      alignfirstCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(report)})`,
      ],
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).issues.map((issue: { path: string }) => issue.path)).toEqual([
      old,
    ]);
    const doctor = await runProjects(fixture, ["doctor"], {
      alignfirstCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(report)})`,
      ],
    });
    expect(doctor.code).toBe(1);
  });

  it("fails the listing when alignfirst is missing", async () => {
    const fixture = makeFixture();
    makeRepository(fixture.root, "candidate");
    const result = await runProjects(fixture, ["list"], {
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });
    expect(result.code).toBe(1);
  });
});

describe("project classification and companions", () => {
  it("carries profile-only and combined selections without requiring a launchable agent", async () => {
    const fixture = makeFixture();
    const one = makeRepository(fixture.root, "one");
    const two = makeRepository(fixture.root, "two");
    const aligndev = { profile: "not-provisioned" };
    writeRegistry(fixture.home, {
      projects: {
        [one]: { aligndev },
        [two]: { dir: "two", aligndev },
      },
    });
    const list = await runProjects(fixture, ["list", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      issues: [],
      projects: [
        { name: "one", companion: null, aligndev },
        { name: "two", aligndev },
      ],
    });
    const status = await runProjects(fixture, ["status", one, "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      companion: null,
      aligndev,
      locations: { _aligndev: { path: join(one, ".plans"), in: "project", exists: false } },
    });
    expect(existsSync(join(fixture.home, ".alignfirst", "companions", "two"))).toBe(false);
    expect(existsSync(join(one, ".plans"))).toBe(false);
  });

  it("lists a git repository without config as a project and a non-git config as an issue", async () => {
    const fixture = makeFixture();
    const bare = makeRepository(fixture.root, "bare");
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    mkdirSync(join(fixture.root, "plain"));

    const report = await listJson(fixture);
    expect(report.projects.map(({ path }: Project) => path)).toEqual([bare]);
    expect(report.projects[0].companion).toBeNull();
    expect(report.projects[0].locations[".plans"]).toEqual({
      path: join(bare, ".plans"),
      in: "project",
      exists: false,
    });
    expect(report.issues.map((issue: { path: string }) => issue.path)).toEqual([
      realpathSync(nongit),
    ]);
  });

  it("skips a repository holding another project's .plans target", async () => {
    const fixture = makeFixture();
    const app = makeRepository(fixture.root, "app");
    const clone = makeRepository(fixture.root, "team-plans");
    mkdirSync(join(clone, "app"));
    symlinkSync(join(clone, "app"), join(app, ".plans"));

    const report = await listJson(fixture);
    expect(report.projects.map(({ path }: Project) => path)).toEqual([app]);
    expect(report.skippedDirectories).toEqual([{ path: clone, reason: "workFilesRepository" }]);
  });

  it("reports the companion and the locations in list and status", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "app");
    const companionsRoot = join(fixture.home, ".alignfirst", "companions");
    mkdirSync(companionsRoot, { recursive: true });
    writeRegistry(fixture.home, {
      projects: {
        [project]: {
          dir: "app",
          items: { ".plans": "companion", assistantInstructionsFile: "companion" },
        },
      },
    });
    const companion = join(realpathSync(companionsRoot), "app");
    mkdirSync(join(companion, ".plans"), { recursive: true });

    const list = await listJson(fixture);
    expect(list.projects[0].companion).toMatchObject({
      dir: companion,
      exists: true,
      defaultLocation: "auto",
      items: { assistantInstructionsFile: "companion" },
    });
    expect(list.projects[0].locations[".plans"]).toEqual({
      path: join(companion, ".plans"),
      in: "companion",
      exists: true,
    });

    const status = JSON.parse((await runProjects(fixture, ["status", "app", "--json"])).stdout);
    expect(status.configSource).toBeNull();
    expect(status.companion).toEqual(list.projects[0].companion);
    expect(status.locations.assistantInstructionsFile).toBeNull();
  });

  it("uses a selected companion range for inventory and free-port lookup without merging project settings", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(28100, 28199) });
    const project = makeRepository(fixture.root, "app", { portRange: range(28100, 28109) });
    const companion = join(fixture.home, ".alignfirst/companions/app");
    mkdirSync(companion, { recursive: true });
    writeProjectConfig(companion, {
      portRange: range(28120, 28129),
      assistantInstructionsFile: "notes/dev.md",
    });
    writeRegistry(fixture.home, {
      projects: {
        [project]: {
          dir: "app",
          items: { alignfirst: "companion", assistantInstructionsFile: "companion" },
        },
      },
    });
    const listed = await runProjects(fixture, ["list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const report = JSON.parse(listed.stdout);
    expect(report.projects[0].portRange).toEqual(range(28120, 28129));
    expect(report.projects[0].locations.assistantInstructionsFile).toEqual({
      path: join(companion, "notes/dev.md"),
      in: "companion",
      exists: false,
    });
    expect(report.issues).toEqual([]);
    const free = await runProjects(fixture, ["free-ports", "--size", "20", "--json"]);
    expect(free.code, free.stderr).toBe(0);
    expect(JSON.parse(free.stdout)).toEqual(range(28100, 28119));
  });

  it("reports two projects sharing a companion directory on both", async () => {
    const fixture = makeFixture();
    const one = makeRepository(fixture.root, "one");
    const two = makeRepository(fixture.root, "two");
    writeRegistry(fixture.home, {
      projects: { [one]: { dir: "shared" }, [two]: { dir: "shared" } },
    });

    const result = await runProjects(fixture, ["doctor"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(one);
    expect(result.stdout).toContain(two);
    expect(result.stdout).toContain(join(fixture.home, ".alignfirst", "companions", "shared"));
  });
});

describe("project status", () => {
  it("renders root project details and rejects a linked-worktree path", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project", {
      ticketIdPattern: "^P-\\d+$",
      plans: { repositoryFolder: "project-plans" },
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
      configSource: "project",
      companion: null,
      aligndev: null,
      locations: {
        alignfirst: {
          path: join(project, "alignfirst.json"),
          in: "project",
          exists: true,
        },
        ".alignfirst-instructions": {
          path: join(project, ".alignfirst-instructions"),
          in: "project",
          exists: false,
        },
        assistantInstructionsFile: {
          path: join(project, "DEVELOPERS.md"),
          in: "project",
          exists: false,
        },
        workspaceRuntime: { path: join(project, ".local-wt"), in: "project", exists: false },
        docs: { path: join(project, "docs"), in: "project", exists: false },
        ".plans": { path: join(project, ".plans"), in: "project", exists: false },
        _aligndev: { path: join(project, ".plans"), in: "project", exists: false },
      },
      workspaces: ["project-workspace"],
      worktrees: [
        { branch: "main", name: "project", path: project },
        { branch: "feature", name: "project-workspace", path: realpathSync(workspace) },
      ],
    });

    const rejected = await runProjects(fixture, ["status", workspace]);
    expect(rejected.code).toBe(1);
  });

  it("resolves a relative path against the working directory", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");

    const result = await runProjects(fixture, ["status", ".", "--json", "--root", fixture.root], {
      cwd: project,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).path).toBe(project);
  });
});

describe("project ports", () => {
  it("finds the lowest block around project ranges from several groups", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8099) });
    for (const [group, ports] of [
      ["web", range(8000, 8009)],
      ["tools", range(8020, 8029)],
    ] as const) {
      mkdirSync(join(fixture.root, group));
      makeRepository(join(fixture.root, group), "app", { portRange: ports });
    }

    const text = await runProjects(fixture, ["free-ports", "--size", "10"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe("8010..8019\n");
    const json = await runProjects(fixture, ["free-ports", "--size", "10", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual(range(8010, 8019));
  });

  it("fails when no block of the size is free", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, { portRange: range(8000, 8019) });
    makeRepository(fixture.root, "app", { portRange: range(8005, 8014) });

    const result = await runProjects(fixture, ["free-ports", "--size", "6"]);

    expect(result.code).toBe(1);
  });

  it("requires portRange in the settings before the scan", async () => {
    const fixture = makeFixture();
    makeRepository(fixture.root, "app");

    const result = await runProjects(fixture, ["free-ports", "--size", "1"], {
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("portRange");
  });
});

interface Project {
  name: string;
  path: string;
  directory: string;
  workspaces: string[];
}

async function listJson(fixture: Fixture, args: string[] = []) {
  const result = await runProjects(fixture, ["list", "--json", ...args]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function runProjects(
  fixture: Fixture,
  args: string[],
  overrides?: RunOverrides,
): Promise<RunResult> {
  return runAligndev(fixture, ["project", ...args], overrides);
}
