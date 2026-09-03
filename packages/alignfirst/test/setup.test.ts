import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setup command", () => {
  it("prepares a project and remains idempotent", async () => {
    const fixture = makeProject();
    const fake = makeFakeNpx(fixture.root);
    const env = fakeEnv(fake.bin, fake.log);
    const args = [
      "setup",
      "--ticket-pattern",
      "^\\d+$",
      "--plans-folder",
      "project",
      "--port-range",
      "8100-8199",
      "--agent",
      "codex",
    ];
    const result = await runMain(args, { cwd: fixture.project, env });
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.project, ".alignfirst.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      cli: ">=0.0.0 <0.1.0",
      ticketPattern: "^\\d+$",
      plans: { folder: "project" },
      portRange: { first: 8100, last: 8199 },
    });
    expect(existsSync(join(fixture.project, ".plans"))).toBe(true);
    expect(readFileSync(join(fixture.project, ".gitignore"), "utf-8")).toBe(".plans\n");
    expect(readFileSync(join(fixture.project, "README.md"), "utf-8")).toContain(
      "npm install -g alignfirst",
    );
    const npxArgs = readFileSync(fake.log, "utf-8");
    for (const skill of [
      "alignfirst",
      "alspec",
      "alplan",
      "al",
      "alcatchup",
      "almerge",
      "alreview",
      "aldescription",
    ])
      expect(npxArgs).toContain(`--skill\n${skill}\n`);
    expect(npxArgs).toContain("--agent\ncodex\n");

    expect((await runMain(["setup"], { cwd: fixture.project, env })).code).toBe(0);
    expect(readFileSync(join(fixture.project, ".gitignore"), "utf-8")).toBe(".plans\n");
    expect(
      readFileSync(join(fixture.project, "README.md"), "utf-8").match(/Prerequisites/g),
    ).toHaveLength(1);
  });

  it("rejects options with an existing config and validates config input", async () => {
    const fixture = makeProject();
    const fake = makeFakeNpx(fixture.root);
    const env = fakeEnv(fake.bin, fake.log);
    writeFileSync(join(fixture.project, ".alignfirst.json"), '{"schemaVersion":1}');
    expect(
      (
        await runMain(["setup", "--plans-folder", "other"], {
          cwd: fixture.project,
          env,
        })
      ).stderr,
    ).toContain("edit it instead of passing options");
    writeFileSync(join(fixture.project, ".alignfirst.json"), "{");
    expect((await runMain(["setup"], { cwd: fixture.project, env })).stderr).toContain("Invalid");
    rmSync(join(fixture.project, ".alignfirst.json"));
    expect(
      (
        await runMain(["setup", "--port-range", "9-3"], {
          cwd: fixture.project,
          env,
        })
      ).stderr,
    ).toContain("first must not exceed");
  });

  it("creates an overlay with a shared plans link", async () => {
    const fixture = makeProject();
    const overlays = join(fixture.root, "overlays");
    mkdirSync(overlays);
    git(overlays, "init", "--quiet");
    const result = await runMain(
      ["setup", "--overlay", "--plans-folder", "project", "--port-range", "8100-8199"],
      { cwd: fixture.project, env: { ALIGNFIRST_OVERLAYS: overlays } },
    );
    expect(result.code).toBe(0);
    const overlayDir = join(overlays, "project", "_project");
    expect(JSON.parse(readFileSync(join(overlayDir, ".alignfirst.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      project: {
        remote: "github.com/org/project",
        paths: [realpathSync(fixture.project)],
      },
      plans: { folder: "project" },
      portRange: { first: 8100, last: 8199 },
    });
    expect(lstatSync(join(fixture.project, ".plans")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.project, ".plans"))).toBe(join("..", "overlays", "project"));
    expect(readFileSync(join(fixture.project, ".git", "info", "exclude"), "utf-8")).toContain(
      ".plans",
    );
    expect(
      (
        await runMain(["setup", "--overlay", "--plans-folder", "project"], {
          cwd: fixture.project,
          env: { ALIGNFIRST_OVERLAYS: overlays },
        })
      ).stderr,
    ).toContain("already exists");
  });

  it("uses local plans for an overlay outside a git repository", async () => {
    const fixture = makeProject();
    const overlays = join(fixture.root, "plain-overlays");
    mkdirSync(overlays);
    const result = await runMain(["setup", "--overlay"], {
      cwd: fixture.project,
      env: { ALIGNFIRST_OVERLAYS: overlays },
    });
    expect(result.code).toBe(0);
    expect(lstatSync(join(fixture.project, ".plans")).isDirectory()).toBe(true);
  });

  it("requires the overlays variable", async () => {
    const fixture = makeProject();
    expect((await runMain(["setup", "--overlay"], { cwd: fixture.project })).stderr).toContain(
      "ALIGNFIRST_OVERLAYS is not set",
    );
  });

  it("adopts overlay files and removes an empty overlay", async () => {
    const fixture = makeProject();
    const overlays = join(fixture.root, "overlays");
    const overlayDir = join(overlays, "project", "_project");
    mkdirSync(join(overlayDir, "docs"), { recursive: true });
    writeFileSync(
      join(overlayDir, ".alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { paths: [realpathSync(fixture.project)] },
      }),
    );
    writeFileSync(join(overlayDir, "AGENTS.md"), "agents\n");
    writeFileSync(join(overlayDir, "DEVELOPERS.md"), "developers\n");
    writeFileSync(join(overlayDir, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(fixture.project, ".git", "info", "exclude"), ".plans\n");
    const result = await runMain(["setup", "--adopt"], {
      cwd: fixture.project,
      env: { ALIGNFIRST_OVERLAYS: overlays },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.project, ".alignfirst.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
    });
    expect(readFileSync(join(fixture.project, "AGENTS.md"), "utf-8")).toBe("agents\n");
    expect(existsSync(join(fixture.project, "docs", "guide.md"))).toBe(true);
    expect(existsSync(overlayDir)).toBe(false);
    expect(readFileSync(join(fixture.project, ".git", "info", "exclude"), "utf-8")).not.toContain(
      ".plans",
    );
  });
});

interface ProjectFixture {
  root: string;
  project: string;
}

function makeProject(): ProjectFixture {
  const root = makeTempDir("alignfirst-setup-");
  dirs.push(root);
  configureGit(root);
  const project = join(root, "project");
  git(root, "init", "--quiet", project);
  git(project, "remote", "add", "origin", "https://github.com/org/project.git");
  writeFileSync(join(project, "README.md"), "# Project\n");
  return { root, project };
}

interface FakeCommand {
  bin: string;
  log: string;
}

function makeFakeNpx(root: string): FakeCommand {
  const bin = join(root, "bin");
  const log = join(root, "npx.log");
  mkdirSync(bin);
  const executable = join(bin, "npx");
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$NPX_LOG"\n');
  chmodSync(executable, 0o755);
  return { bin, log };
}

function fakeEnv(bin: string, log: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, NPX_LOG: log };
}
