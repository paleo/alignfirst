import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, parseAlprojectArgs, renderProjectList, renderProjectListJson } from "../src/cli.js";

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir !== undefined) rmSync(fixtureDir, { force: true, recursive: true });
  fixtureDir = undefined;
});

describe("parseAlprojectArgs", () => {
  it("parses every command and global mode", () => {
    expect(parse(["list"])).toMatchObject({ command: "list" });
    expect(parse(["list", "--json"])).toMatchObject({ command: "list", json: true });
    expect(parse(["register", "project"])).toMatchObject({
      command: "register",
      path: "project",
    });
    expect(parse(["unregister", "project"])).toMatchObject({
      command: "unregister",
      path: "project",
    });
    expect(parse(["--guide"]).guide).toBe(true);
    expect(parse(["-h"]).help).toBe(true);
    expect(parse(["--help"]).help).toBe(true);
    expect(parse(["-v"]).version).toBe(true);
    expect(parse(["--version"]).version).toBe(true);
  });

  it("rejects unknown options and commands", () => {
    expect(() => parse(["--unknown"])).toThrow(/Unknown option/);
    expect(() => parse(["unknown"])).toThrow("Unknown command: unknown");
  });

  it("requires exact command path counts", () => {
    expect(() => parse(["list", "project"])).toThrow("list does not accept a path");
    expect(() => parse(["register"])).toThrow("register requires exactly one path");
    expect(() => parse(["register", "one", "two"])).toThrow("register requires exactly one path");
    expect(() => parse(["unregister"])).toThrow("unregister requires exactly one path");
    expect(() => parse(["unregister", "one", "two"])).toThrow(
      "unregister requires exactly one path",
    );
  });

  it("requires paired positive integer port options only on register", () => {
    expect(() => parse(["--ports-per-workspace", "2", "--max-workspaces", "2"])).toThrow(
      /only with register/,
    );
    expect(() => parse(["register", "project", "--ports-per-workspace", "2"])).toThrow(
      /provided together/,
    );
    expect(() =>
      parse(["register", "project", "--ports-per-workspace", "0", "--max-workspaces", "2"]),
    ).toThrow(/positive integer/);
    expect(() => parse(["list", "--ports-per-workspace", "2", "--max-workspaces", "2"])).toThrow(
      /only with register/,
    );
    expect(
      parse(["register", "project", "--ports-per-workspace", "5", "--max-workspaces", "3"]),
    ).toMatchObject({ maxWorkspaces: 3, portsPerWorkspace: 5 });
  });

  it("rejects invalid global-mode combinations", () => {
    expect(() => parse(["--guide", "--help"])).toThrow(/mutually exclusive/);
    expect(() => parse(["list", "--guide"])).toThrow(/does not accept a command/);
    expect(() => parse(["--guide", "--ports-per-workspace", "2"])).toThrow(
      /does not accept command options/,
    );
    expect(() => parse(["register", "project", "--json"])).toThrow(/only with list/);
    expect(() => parse(["--json"])).toThrow(/only with list/);
  });
});

describe("main", () => {
  it("prints help for a bare invocation without configuration", async () => {
    const stdout = makeSink();
    expect(await run([], { stdout })).toBe(0);
    expect(stdout.text()).toContain("alproject register <path>");
    expect(stdout.text()).toContain("alproject --guide");
  });

  it("prints help aliases and version aliases without configuration", async () => {
    for (const option of ["-h", "--help"]) {
      const stdout = makeSink();
      expect(await run([option], { stdout })).toBe(0);
      expect(stdout.text()).toContain("Usage:");
    }
    for (const option of ["-v", "--version"]) {
      const stdout = makeSink();
      expect(await run([option], { stdout })).toBe(0);
      expect(stdout.text()).toBe("0.0.0\n");
    }
  });

  it("prints the guide with optional custom content", async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.root, "alproject-guide.md"), "# Local rules\n\nPreserve me.\n");
    const stdout = makeSink();

    expect(await run(["--guide"], { home: fixture.home, stdout })).toBe(0);
    expect(stdout.text()).toContain("# alproject guide");
    expect(stdout.text()).toContain("# Project-specific guide\n\n# Local rules\n\nPreserve me.\n");
  });

  it("prints the generic guide without configuration", async () => {
    const home = makeEmptyHome();
    const stdout = makeSink();

    expect(await run(["--guide"], { home, stdout })).toBe(0);
    expect(stdout.text()).toContain("# alproject guide");
    expect(stdout.text()).toContain("Create `~/.alproject.json` before running commands");
  });

  it("writes custom-guide read failures only to stderr", async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.root, "alproject-guide.md"));
    const stdout = makeSink();
    const stderr = makeSink();

    expect(await run(["--guide"], { home: fixture.home, stderr, stdout })).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/Cannot read custom guide/);
  });

  it("writes argument failures only to stderr", async () => {
    const stdout = makeSink();
    const stderr = makeSink();
    expect(await run(["--unknown"], { stderr, stdout })).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/Unknown option/);
  });

  it("keeps control characters in errors on one physical line", async () => {
    const stderr = makeSink();

    expect(await run(["list"], { home: "/missing\nhome", stderr })).toBe(1);
    expect(stderr.text()).toContain("/missing\\nhome");
    expect(stderr.text().split("\n")).toHaveLength(2);
  });

  it("registers, lists, and unregisters through the package APIs", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    const registerOutput = makeSink();
    expect(
      await run(["register", "project", "--ports-per-workspace", "5", "--max-workspaces", "2"], {
        home: fixture.home,
        stdout: registerOutput,
      }),
    ).toBe(0);
    expect(registerOutput.text()).toBe(
      `Registered project: ${JSON.stringify(project)}\nBase port: 8000\nPort range: 8000..8009\n`,
    );

    const listOutput = makeSink();
    expect(await run(["list"], { home: fixture.home, stdout: listOutput })).toBe(0);
    expect(listOutput.text()).toContain('- Name: "project"');
    expect(listOutput.text()).toContain(`  Main path: ${JSON.stringify(project)}`);
    expect(listOutput.text()).toContain(`  Parent: ${JSON.stringify(fixture.root)}`);
    expect(listOutput.text()).toContain("  Status: registered");
    expect(listOutput.text()).toContain("  Workspaces: (none)");
    expect(listOutput.text()).toContain("  Base port: 8000");
    expect(listOutput.text()).toContain("  Port range: 8000..8009");

    const unregisterOutput = makeSink();
    expect(
      await run(["unregister", project], {
        home: fixture.home,
        stdout: unregisterOutput,
      }),
    ).toBe(0);
    expect(unregisterOutput.text()).toBe(`Unregistered project: ${JSON.stringify(project)}\n`);

    const jsonOutput = makeSink();
    expect(await run(["list", "--json"], { home: fixture.home, stdout: jsonOutput })).toBe(0);
    expect(JSON.parse(jsonOutput.text()).projects[0]).toMatchObject({
      name: "project",
      path: project,
      status: "unregistered",
    });
  });

  it("reports duplicate and exhaustion errors only to stderr", async () => {
    const fixture = makeFixture(8000, 8000);
    makeRepository(fixture.root, "one");
    makeRepository(fixture.root, "two");
    expect(
      await run(["register", "one", "--ports-per-workspace", "1", "--max-workspaces", "1"], {
        home: fixture.home,
        stdout: makeSink(),
      }),
    ).toBe(0);

    const duplicateStdout = makeSink();
    const duplicateStderr = makeSink();
    expect(
      await run(["register", "one"], {
        home: fixture.home,
        stderr: duplicateStderr,
        stdout: duplicateStdout,
      }),
    ).toBe(1);
    expect(duplicateStdout.text()).toBe("");
    expect(duplicateStderr.text()).toMatch(/already registered/);

    const exhaustionStdout = makeSink();
    const exhaustionStderr = makeSink();
    expect(
      await run(["register", "two", "--ports-per-workspace", "1", "--max-workspaces", "1"], {
        home: fixture.home,
        stderr: exhaustionStderr,
        stdout: exhaustionStdout,
      }),
    ).toBe(1);
    expect(exhaustionStdout.text()).toBe("");
    expect(exhaustionStderr.text()).toMatch(/No contiguous block/);
  });

  it("unregisters a missing path and preserves filesystem content", async () => {
    const fixture = makeFixture();
    const project = makeRepository(fixture.root, "project");
    expect(await run(["register", project], { home: fixture.home, stdout: makeSink() })).toBe(0);
    const moved = `${project}-moved`;
    renameSync(project, moved);

    expect(await run(["unregister", project], { home: fixture.home, stdout: makeSink() })).toBe(0);
    expect(readFileSync(join(moved, "README.md"), "utf8")).toBe("project\n");
  });
});

describe("renderProjectList", () => {
  it("renders complete labelled records and grouped directories in input order", () => {
    const output = renderProjectList({
      additionalDirectories: [{ directories: ["a-extra", "z-extra"], parent: "/parents/b" }],
      projects: [
        {
          name: "alpha",
          parent: "/parents/a",
          path: "/parents/a/alpha",
          status: "unregistered",
          workspaces: ["a-workspace", "z-workspace"],
        },
        {
          name: "gone",
          parent: "/parents/b",
          path: "/parents/b/gone",
          ports: { basePort: 8010, endPort: 8019, maxWorkspaces: 2, portsPerWorkspace: 5 },
          status: "missing",
          workspaces: [],
        },
      ],
    });

    expect(output).toContain("Status: unregistered on filesystem");
    expect(output).toContain('Workspaces: "a-workspace", "z-workspace"');
    expect(output).toContain("Status: registered but missing from filesystem");
    expect(output).toContain("Base port: 8010");
    expect(output.indexOf("a-extra")).toBeLessThan(output.indexOf("z-extra"));
  });

  it("escapes control characters in labelled output and preserves them in JSON", () => {
    const list = {
      additionalDirectories: [],
      projects: [
        {
          name: "evil\n  Main path: /injected",
          parent: "/parents/a",
          path: "/parents/a/evil\nname",
          status: "registered" as const,
          workspaces: [],
        },
      ],
    };

    const labelled = renderProjectList(list);
    expect(labelled).toContain('Name: "evil\\n  Main path: /injected"');
    expect(labelled.match(/\n {2}Main path:/gu)).toHaveLength(1);
    expect(JSON.parse(renderProjectListJson(list)).projects[0].name).toBe(list.projects[0].name);
  });
});

interface Fixture {
  home: string;
  root: string;
}

function makeFixture(firstPort = 8000, lastPort = 8999): Fixture {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-cli-"));
  const home = join(fixtureDir, "home");
  const root = join(fixtureDir, "projects");
  mkdirSync(home);
  mkdirSync(root);
  writeFileSync(
    join(home, ".alproject.json"),
    `${JSON.stringify({ firstPort, lastPort, root })}\n`,
  );
  return { home, root };
}

function makeEmptyHome(): string {
  fixtureDir = mkdtempSync(join(tmpdir(), "alproject-cli-"));
  const home = join(fixtureDir, "home");
  mkdirSync(home);
  return home;
}

function makeRepository(parent: string, name: string): string {
  const project = join(parent, name);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", project]);
  writeFileSync(join(project, "README.md"), `${name}\n`);
  return project;
}

function parse(args: string[]) {
  return parseAlprojectArgs(["node", "alproject", ...args]);
}

function makeSink(): { text(): string; write(value: string): void } {
  let output = "";
  return {
    text: () => output,
    write(value) {
      output += value;
    },
  };
}

function run(
  args: string[],
  options: {
    home?: string;
    stderr?: ReturnType<typeof makeSink>;
    stdout?: ReturnType<typeof makeSink>;
  },
) {
  return main({ argv: ["node", "alproject", ...args], ...options });
}
