import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeCompanions, writeConfig } from "../helpers.js";
import {
  addWorktree,
  execGit,
  type Fixture,
  makeFixture,
  makeProjectsDirectory,
  makeRepository,
  type RunOverrides,
  type RunResult,
  range,
  readJson,
  runAldev,
  useProjectFixtures,
  writeProjectConfig,
} from "./fixtures.js";

useProjectFixtures();

describe("projects command surface", () => {
  it("renders help without a coding-agent selection", async () => {
    const fixture = makeFixture();
    for (const args of [["--help"], []]) {
      const result = await runProjects(fixture, args, { env: {} });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("aldev project doctor [--root <path>]");
      expect(result.stdout).toContain("aldev project free-ports --size <n> [--range <code>]");
      expect(result.stdout).not.toContain("--guide");
    }
  });

  it("requires a marker and expands --root ~/ against the injected home", async () => {
    const fixture = makeFixture();
    const projects = join(fixture.home, "projects");
    mkdirSync(projects);
    const result = await runProjects(fixture, ["list", "--root", "~/projects"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".alignfirst-projects.json is missing");
    expect(result.stderr).toContain("Run `aldev project init` there");
    expect(result.stderr).toContain("--root <path>");
  });

  it("defaults --root to projectsRoot in the config, and lets --root override it", async () => {
    const fixture = makeFixture({});
    makeRepository(fixture.root, "configured", {});
    const other = join(fixture.base, "other");
    mkdirSync(other);
    writeFileSync(join(other, ".alignfirst-projects.json"), "{}\n");
    const cwd = join(fixture.base, "elsewhere");
    mkdirSync(cwd);
    writeConfig(fixture.home, { projectsRoot: fixture.root });

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
    writeFileSync(join(projects, ".alignfirst-projects.json"), "{}\n");
    writeConfig(fixture.home, { projectsRoot: "~/projects" });

    const result = await runProjects(fixture, ["list", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).root).toBe(realpathSync(projects));
  });

  it("initializes a marker with several ranges and refuses overwrite", async () => {
    const fixture = makeFixture();
    const created = await runProjects(fixture, [
      "init",
      "--description",
      "Services",
      "--port-range",
      "8000-8099",
      "--port-range",
      "local=9000-9099",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created");
    expect(readJson(join(fixture.root, ".alignfirst-projects.json"))).toEqual({
      description: "Services",
      portRanges: [
        { first: 8000, last: 8099 },
        { code: "local", first: 9000, last: 9099 },
      ],
    });

    const duplicate = await runProjects(fixture, ["init"]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toContain("already exists");

    const other = makeFixture();
    const invalid = await runProjects(other, ["init", "--port-range", "9000-8000"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("must not exceed");
  });

  it("rejects invalid groups of init port ranges before writing", async () => {
    for (const args of [
      ["--port-range", "8000-8099", "--port-range", "8100-8199"],
      ["--port-range", "8000-8099", "--port-range", "local=8050-8199"],
    ]) {
      const fixture = makeFixture();
      const result = await runProjects(fixture, ["init", ...args]);
      expect(result.code).toBe(1);
      expect(existsSync(join(fixture.root, ".alignfirst-projects.json"))).toBe(false);
    }
  });

  it("rejects unknown marker fields and names the marker file", async () => {
    const fixture = makeFixture({ unknown: true });
    const result = await runProjects(fixture, ["list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(join(fixture.root, ".alignfirst-projects.json"));
    expect(result.stderr).toContain("unknown");
  });

  it("rejects invalid marker range groups and the legacy field", async () => {
    const cases: [object, string][] = [
      [
        {
          portRanges: [
            { code: "web", ...range(8000, 8099) },
            { code: "local", ...range(8050, 8199) },
          ],
        },
        "port ranges 8000..8099 and 8050..8199 overlap",
      ],
      [
        {
          portRanges: [
            { code: "web", ...range(8000, 8099) },
            { code: "web", ...range(8100, 8199) },
          ],
        },
        'duplicate port range code "web"',
      ],
      [
        { portRanges: [range(8000, 8099), range(8100, 8199)] },
        "at most one port range may have no code",
      ],
      [{ portRange: range(8000, 8099) }, "portRange"],
    ];
    for (const [marker, message] of cases) {
      const fixture = makeFixture(marker);
      const result = await runProjects(fixture, ["list"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(join(fixture.root, ".alignfirst-projects.json"));
      expect(result.stderr).toContain(message);
    }
  });

  it("validates command-specific options", async () => {
    const fixture = makeFixture();
    for (const args of [
      ["status"],
      ["list", "extra"],
      ["init", "--json"],
      ["doctor", "--json"],
      ["list", "--size", "2"],
      ["list", "--range", "local"],
      ["free-ports"],
      ["--guide"],
    ]) {
      expect((await runProjects(fixture, args)).code).toBe(1);
    }
  });
});

describe("project inventory doctor", () => {
  it("reports a clean inventory", async () => {
    const fixture = makeFixture({ portRanges: [range(8000, 8099)] });
    makeRepository(fixture.root, "healthy", { portRange: range(8000, 8049) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result).toEqual({
      code: 0,
      stdout: "[ok] Project inventory: 1 project, 1 directory\n",
      stderr: "",
    });
  });

  it("reports every overlapping pair with both project paths and ranges", async () => {
    const fixture = makeFixture({ portRanges: [range(8000, 8099)] });
    const alpha = makeRepository(fixture.root, "alpha", { portRange: range(8000, 8050) });
    const beta = makeRepository(fixture.root, "beta", { portRange: range(8020, 8070) });
    const gamma = makeRepository(fixture.root, "gamma", { portRange: range(8040, 8090) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      `[error] Port conflict: ${JSON.stringify(alpha)} (8000..8050) overlaps ${JSON.stringify(beta)} (8020..8070)`,
      `[error] Port conflict: ${JSON.stringify(alpha)} (8000..8050) overlaps ${JSON.stringify(gamma)} (8040..8090)`,
      `[error] Port conflict: ${JSON.stringify(beta)} (8020..8070) overlaps ${JSON.stringify(gamma)} (8040..8090)`,
    ]);
  });

  it("reports conflicting peer claims without flagging parent-child containment", async () => {
    const fixture = makeFixture({ portRanges: [range(8000, 8999)] });
    const project = makeRepository(fixture.root, "project", { portRange: range(8100, 8149) });
    const nested = makeProjectsDirectory(fixture.root, "nested", {
      portRanges: [range(8120, 8199)],
    });
    const other = makeProjectsDirectory(fixture.root, "other", {
      portRanges: [range(8180, 8200)],
    });
    makeRepository(nested, "child", { portRange: range(8120, 8130) });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout.trim().split("\n")).toEqual([
      `[error] Port conflict: ${JSON.stringify(nested)} (8120..8199) overlaps ${JSON.stringify(other)} (8180..8200)`,
      `[error] Port conflict: ${JSON.stringify(nested)} (8120..8199) overlaps ${JSON.stringify(project)} (8100..8149)`,
    ]);
  });

  it("fails when a project's AlignFirst CLI range is unsatisfied", async () => {
    const fixture = makeFixture({});
    const project = makeRepository(fixture.root, "project", { cli: ">=99.0.0" });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`[error] Project inventory: ${JSON.stringify(project)}:`);
    expect(result.stdout).toMatch(
      /AlignFirst CLI \d+\.\d+\.\d+(?:[-+]\S+)? does not satisfy required range >=99\.0\.0/u,
    );
  });

  it("fails for invalid configuration and incomplete discovery", async () => {
    const fixture = makeFixture({});
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    const invalid = makeRepository(fixture.root, "invalid");
    writeFileSync(join(invalid, ".alignfirst.json"), "{}\n");

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `[error] Project inventory: ${JSON.stringify(invalid)}: Invalid `,
    );
    expect(result.stdout).toContain(
      `[error] Project inventory: ${JSON.stringify(nongit)}: not a git main worktree`,
    );
  });

  it("renders discovery failures as a failing health line", async () => {
    const fixture = makeFixture({ unknown: true });

    const result = await runProjects(fixture, ["doctor"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^\[error\] Project inventory: Invalid projects marker /u);
  });
});

describe("project discovery", () => {
  it("discovers nested projects, portless projects, others, and cross-directory worktrees", async () => {
    const fixture = makeFixture({
      description: "All projects",
      portRanges: [range(8000, 8999)],
    });
    const alpha = makeRepository(fixture.root, "alpha", {
      portRange: range(8000, 8099),
    });
    const portless = makeRepository(fixture.root, "portless", {
      plans: { autoArchive: true },
    });
    const nested = makeProjectsDirectory(fixture.root, "nested", {
      description: "Nested",
      portRanges: [range(8500, 8599)],
    });
    const beta = makeRepository(nested, "beta", { portRange: range(8500, 8549) });
    mkdirSync(join(nested, "notes"));
    addWorktree(alpha, join(nested, "alpha-workspace"), "feature");

    const result = await runProjects(fixture, ["list", "--json"], { env: {} });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    const projects = report.projects.map(
      ({ companion, locations, ...project }: Record<string, unknown>) => project,
    );
    expect(report.root).toBe(realpathSync(fixture.root));
    expect(report.directories).toEqual([
      {
        path: realpathSync(fixture.root),
        description: "All projects",
        portRanges: [range(8000, 8999)],
        others: [],
      },
      {
        path: realpathSync(nested),
        description: "Nested",
        portRanges: [range(8500, 8599)],
        others: ["notes"],
      },
    ]);
    expect(projects).toEqual([
      {
        name: "alpha",
        path: alpha,
        directory: realpathSync(fixture.root),
        portRange: range(8000, 8099),
        portRangeCode: null,
        workspaces: ["alpha-workspace"],
      },
      {
        name: "beta",
        path: beta,
        directory: realpathSync(nested),
        portRange: range(8500, 8549),
        portRangeCode: null,
        workspaces: [],
      },
      {
        name: "portless",
        path: portless,
        directory: realpathSync(fixture.root),
        portRange: null,
        portRangeCode: null,
        workspaces: [],
      },
    ]);
    expect(report.issues).toEqual([]);
  });

  it("reports range, worktree, config, and overlap issues", async () => {
    const fixture = makeFixture({ portRanges: [range(8000, 8099)] });
    makeRepository(fixture.root, "a", { portRange: range(8000, 8049) });
    makeRepository(fixture.root, "b", { portRange: range(8030, 8059) });
    makeRepository(fixture.root, "outside", { portRange: range(8200, 8299) });
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    const invalid = makeRepository(fixture.root, "invalid");
    writeFileSync(join(invalid, ".alignfirst.json"), "{}\n");
    makeProjectsDirectory(fixture.root, "nested-outside", {
      portRanges: [range(9000, 9099)],
    });
    const result = await runProjects(fixture, ["list", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    const messages = report.issues.map((issue: { message: string }) => issue.message);
    expect(messages).toContain("port range 8030..8059 overlaps a");
    expect(messages).toContain("port range 8200..8299 fits no single enclosing range: 8000..8099");
    expect(messages).toContain("port range 9000..9099 fits no single enclosing range: 8000..8099");
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

  it("reports claims outside or straddling enclosing ranges", async () => {
    const fixture = makeFixture({
      portRanges: [range(8000, 8049), { code: "local", ...range(8050, 8099) }],
    });
    makeRepository(fixture.root, "outside", { portRange: range(8200, 8219) });
    makeRepository(fixture.root, "straddling", { portRange: range(8040, 8059) });

    const result = await runProjects(fixture, ["list", "--json"]);
    const messages = JSON.parse(result.stdout).issues.map(
      (issue: { message: string }) => issue.message,
    );
    expect(messages).toContain(
      "port range 8200..8219 fits no single enclosing range: 8000..8049, 8050..8099",
    );
    expect(messages).toContain(
      "port range 8040..8059 fits no single enclosing range: 8000..8049, 8050..8099",
    );
  });

  it("renders coded ranges and project range codes in text and JSON", async () => {
    const portRanges = [
      { ...range(8000, 8099), description: "Web projects." },
      { code: "local", ...range(9000, 9099), description: "Desktop apps." },
    ];
    const fixture = makeFixture({ description: "All projects", portRanges });
    const nested = makeProjectsDirectory(fixture.root, "nested", {});
    makeRepository(nested, "desktop", { portRange: range(9000, 9019) });
    makeRepository(fixture.root, "web", { portRange: range(8000, 8019) });

    const text = await runProjects(fixture, ["list"]);
    expect(text.stdout).toContain("  Port ranges:\n    8000..8099 (default) — Web projects.");
    expect(text.stdout).toContain("    9000..9099 (local) — Desktop apps.");
    expect(text.stdout).toContain("  Port range: 9000..9019 (local)");

    const json = JSON.parse((await runProjects(fixture, ["list", "--json"])).stdout);
    expect(json.directories[0].portRanges).toEqual(portRanges);
    expect(json.directories[1].portRanges).toEqual([]);
    expect(json.projects.find(({ name }: { name: string }) => name === "desktop")).toEqual(
      expect.objectContaining({ portRangeCode: "local" }),
    );
    expect(json.projects.find(({ name }: { name: string }) => name === "web")).toEqual(
      expect.objectContaining({ portRangeCode: null }),
    );
  });

  it("fails the listing when alignfirst is missing", async () => {
    const fixture = makeFixture({});
    makeRepository(fixture.root, "candidate");
    const result = await runProjects(fixture, ["list"], {
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("alignfirst is not installed");
  });
});

describe("project classification and companions", () => {
  it("lists a git repository without config as a project and a non-git config as an issue", async () => {
    const fixture = makeFixture({});
    const bare = makeRepository(fixture.root, "bare");
    const nongit = join(fixture.root, "nongit");
    mkdirSync(nongit);
    writeProjectConfig(nongit, {});
    mkdirSync(join(fixture.root, "plain"));

    const report = JSON.parse((await runProjects(fixture, ["list", "--json"])).stdout);
    expect(report.projects.map(({ path }: { path: string }) => path)).toEqual([bare]);
    expect(report.projects[0].companion).toBeNull();
    expect(report.projects[0].locations[".plans"]).toEqual({
      path: join(bare, ".plans"),
      in: "project",
      exists: false,
    });
    expect(report.directories[0].others).toEqual(["plain"]);
    expect(report.issues).toEqual([
      { path: realpathSync(nongit), message: "not a git main worktree" },
    ]);
  });

  it("reports the companion and the locations in list and status", async () => {
    const fixture = makeFixture({});
    const project = makeRepository(fixture.root, "app");
    const companionsRoot = join(fixture.base, "companions");
    mkdirSync(companionsRoot);
    writeCompanions(fixture.home, {
      root: companionsRoot,
      paths: { [fixture.root]: { ".plans": true, "DEVELOPERS.md": true } },
    });
    const companion = join(realpathSync(companionsRoot), project.slice(1).replaceAll("/", "_"));
    mkdirSync(join(companion, ".plans"), { recursive: true });

    const list = JSON.parse((await runProjects(fixture, ["list", "--json"])).stdout);
    expect(list.projects[0].companion).toEqual({ dir: companion, exists: true });
    expect(list.projects[0].locations[".plans"]).toEqual({
      path: join(companion, ".plans"),
      in: "companion",
      exists: true,
    });

    const status = JSON.parse((await runProjects(fixture, ["status", "app", "--json"])).stdout);
    expect(status.configSource).toBeNull();
    expect(status.companion).toEqual({ dir: companion, exists: true });
    expect(status.locations["DEVELOPERS.md"]).toEqual({
      path: join(companion, "DEVELOPERS.md"),
      in: "companion",
      exists: false,
    });

    const text = (await runProjects(fixture, ["status", "app"])).stdout;
    expect(text).toContain("  Config source: (none)\n");
    expect(text).toContain(`  Companion: ${JSON.stringify(companion)}\n`);
    expect(text).toContain(
      `  DEVELOPERS.md: ${JSON.stringify(join(companion, "DEVELOPERS.md"))} (missing)\n`,
    );
    expect(text).toContain(`  Work files: ${JSON.stringify(join(companion, ".plans"))}\n`);
  });

  it("reports two projects sharing a companion directory on both", async () => {
    const fixture = makeFixture({});
    const flat = makeRepository(fixture.root, "a_b");
    const nested = makeRepository(makeProjectsDirectory(fixture.root, "a", {}), "b");
    writeCompanions(fixture.home, {
      root: join(fixture.base, "companions"),
      paths: { [fixture.root]: {} },
    });

    const result = await runProjects(fixture, ["doctor"]);
    expect(result.code).toBe(1);
    const companion = join(fixture.base, "companions", flat.slice(1).replaceAll("/", "_"));
    expect(result.stdout.trim().split("\n")).toEqual([
      `[error] Project inventory: ${JSON.stringify(flat)}: shares companion directory ` +
        `${companion} with ${nested}`,
      `[error] Project inventory: ${JSON.stringify(nested)}: shares companion directory ` +
        `${companion} with ${flat}`,
    ]);
  });
});

describe("project status", () => {
  it("renders root project details and rejects a linked-worktree path", async () => {
    const fixture = makeFixture({
      portRanges: [{ code: "web", ...range(8000, 8999) }],
    });
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
      portRangeCode: "web",
      plansFolder: "project-plans",
      ticketIdPattern: "^P-\\d+$",
      configSource: "project",
      companion: null,
      locations: {
        ".alignfirst.json": {
          path: join(project, ".alignfirst.json"),
          in: "project",
          exists: true,
        },
        ".alignfirst.md": { path: join(project, ".alignfirst.md"), in: "project", exists: false },
        "DEVELOPERS.md": { path: join(project, "DEVELOPERS.md"), in: "project", exists: false },
        docs: { path: join(project, "docs"), in: "project", exists: false },
        ".plans": { path: join(project, ".plans"), in: "project", exists: false },
        _aldev: { path: join(project, ".plans"), in: "project", exists: false },
      },
      workspaces: ["project-workspace"],
      worktrees: [
        { branch: "main", name: "project", path: project },
        { branch: "feature", name: "project-workspace", path: realpathSync(workspace) },
      ],
    });

    const text = await runProjects(fixture, ["status", project]);
    expect(text.stdout).toContain("Project:\n");
    expect(text.stdout).toContain('  Remote host: "github.com"');
    expect(text.stdout).toContain("  Port range: 8000..8099 (web)");
    expect(text.stdout).toContain('  Ticket id pattern: "^P-\\\\d+$"');
    expect(text.stdout).toContain("  Config source: project\n  Companion: (none)\n");
    expect(text.stdout).toContain(
      `  DEVELOPERS.md: ${JSON.stringify(join(project, "DEVELOPERS.md"))} (missing)\n`,
    );
    expect(text.stdout).toContain(
      `  Work files: ${JSON.stringify(join(project, ".plans"))} (missing)\n`,
    );

    const rejected = await runProjects(fixture, ["status", workspace]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("is not a project of");
    expect(rejected.stderr).toContain("main-worktree path");
  });
});

describe("project ports", () => {
  it("finds the lowest block around project and nested-directory claims", async () => {
    const fixture = makeFixture({ portRanges: [range(8000, 8099)] });
    makeRepository(fixture.root, "allocated", { portRange: range(8000, 8009) });
    makeProjectsDirectory(fixture.root, "nested", { portRanges: [range(8020, 8029)] });

    const text = await runProjects(fixture, ["free-ports", "--size", "10"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe("8010..8019\n");
    const json = await runProjects(fixture, ["free-ports", "--size", "10", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual(range(8010, 8019));

    const exhausted = await runProjects(fixture, ["free-ports", "--size", "80"]);
    expect(exhausted.code).toBe(1);
    expect(exhausted.stderr).toContain("No block of 80 contiguous free ports in 8000..8099");
  });

  it("requires root port ranges for free-ports", async () => {
    const fixture = makeFixture({});
    const result = await runProjects(fixture, ["free-ports", "--size", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no portRanges");
  });

  it("selects a coded range and reports unknown codes", async () => {
    const fixture = makeFixture({
      portRanges: [
        range(8000, 8099),
        { code: "local", ...range(9000, 9099) },
        { code: "worker", ...range(10_000, 10_099) },
      ],
    });
    makeRepository(fixture.root, "desktop", { portRange: range(9000, 9009) });

    const selected = await runProjects(fixture, ["free-ports", "--size", "10", "--range", "local"]);
    expect(selected.stdout).toBe("9010..9019\n");

    const unknown = await runProjects(fixture, [
      "free-ports",
      "--size",
      "10",
      "--range",
      "missing",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown port range code "missing"');
    expect(unknown.stderr).toContain("declared codes: local, worker");
  });

  it("requires an explicit code when the marker has no default range", async () => {
    const fixture = makeFixture({
      portRanges: [
        { code: "local", ...range(9000, 9099) },
        { code: "worker", ...range(10_000, 10_099) },
      ],
    });

    const result = await runProjects(fixture, ["free-ports", "--size", "10"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("declares no default range: pass --range <code>");
    expect(result.stderr).toContain("codes: local, worker");
  });
});

function runProjects(
  fixture: Fixture,
  args: string[],
  overrides?: RunOverrides,
): Promise<RunResult> {
  return runAldev(fixture, ["project", ...args], overrides);
}
