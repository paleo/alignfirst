import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureGit,
  initRepository,
  makeCompanionProject,
  makeTempDir,
  runMain,
  writeRegistry,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config command", () => {
  it("reports missing families without creating files", async () => {
    const cwd = temp();
    const before = readdirSync(cwd);
    const result = await runMain(["config", "--json"], { cwd });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      source: null,
      config: null,
      companion: null,
      aligndev: null,
      workspace: {
        location: { path: join(cwd, "alignfirst.json"), in: "project", exists: false },
        schemaVersion: null,
        portRange: null,
        hasDevServer: false,
      },
      locations: {
        alignfirst: { path: join(cwd, "alignfirst.json"), in: "project", exists: false },
      },
    });
    expect(report).not.toHaveProperty("cli");
    expect(readdirSync(cwd)).toEqual(before);
    const text = await runMain(["config"], { cwd });
    expect(text.stdout).toContain(`alignfirst: ${join(cwd, "alignfirst.json")} (project, missing)`);
    expect(text.stdout).not.toContain("CLI range");
  });

  it("reports authored recipes from the worktree root without executing commands or reading environment", async () => {
    const cwd = temp();
    configureGit(cwd);
    initRepository(cwd);
    const nested = join(cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const sentinel = join(cwd, "executed");
    writeFileSync(
      join(cwd, "alignfirst.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        conventions: { ticketIdPattern: "^TASK-\\d+$" },
        workspace: {
          finalize: [{ name: "sentinel", run: `touch '${sentinel}'`, env: { SECRET: "PRIVATE" } }],
        },
        devServer: {
          ports: { first: 8100, last: 8199, declare: ["api"] },
          servers: [
            {
              kind: "spawn",
              name: "api",
              exec: { run: ["python", "app.py"], env: { SECRET: "PRIVATE" } },
              port: "api",
              ready: { log: "ready" },
            },
          ],
        },
      }),
    );
    const result = await runMain(["config", "--json"], {
      cwd: nested,
      env: { INHERITED_SECRET: "NOT_AUTHORED" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "project",
      workspace: {
        location: { path: join(cwd, "alignfirst.jsonc"), in: "project", exists: true },
        schemaVersion: 1,
        portRange: { first: 8100, last: 8199 },
        hasDevServer: true,
      },
      locations: { alignfirst: { path: join(cwd, "alignfirst.jsonc") } },
    });
    expect(result.stdout).toContain("PRIVATE");
    expect(result.stdout).toContain("touch");
    expect(result.stdout).not.toContain("NOT_AUTHORED");
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(cwd, ".local-wt"))).toBe(false);
  });

  it("selects the whole merged family independently of profile and reports conventions-only capability", async () => {
    const { root, home, project, companion } = makeCompanionProject(
      { alignfirst: "companion" },
      "work",
    );
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(join(companion, "alignfirst.jsonc"), '{"schemaVersion":1}');
    writeFileSync(join(project, "alignfirst.json"), '{"INVALID":true}');
    const result = await runMain(["config", "--json"], { cwd: project, home });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "companion",
      aligndev: { profile: "work" },
      companion: { dir: companion, items: { alignfirst: "companion" } },
      locations: {
        alignfirst: { path: join(companion, "alignfirst.jsonc"), in: "companion", exists: true },
      },
      workspace: {
        location: { path: join(companion, "alignfirst.jsonc"), in: "companion", exists: true },
        schemaVersion: 1,
        portRange: null,
        hasDevServer: false,
      },
    });
    const text = await runMain(["config"], { cwd: project, home });
    expect(text.stdout).toContain('Companion items: "alignfirst": "companion"');
    expect(text.stdout).toContain("AlignDev profile: work");
  });

  it("reports companion recipes and external runtime destinations without creating storage", async () => {
    const { root, home, project, companion } = makeCompanionProject({
      alignfirst: "companion",
      workspaceRuntime: "companion",
    });
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    const authored = {
      schemaVersion: 1,
      devServer: {
        ports: { first: 28100, last: 28199, declare: ["app"] },
        servers: [
          {
            kind: "spawn",
            name: "app",
            exec: { run: ["false"], env: { LITERAL: "authored" } },
            ready: { log: "ready" },
          },
        ],
      },
    };
    writeFileSync(join(companion, "alignfirst.json"), JSON.stringify(authored));
    writeFileSync(join(project, "alignfirst.json"), '{"notSelected":true}');
    const result = await runMain(["config", "--json"], { cwd: project, home });
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      source: "companion",
      config: authored,
      selectionOrigins: {
        alignfirst: "item",
        workspaceRuntime: "item",
        developerInstructions: "builtin",
      },
      locations: {
        developerInstructions: null,
        workspaceRuntime: { in: "companion", exists: false },
      },
      workspace: {
        location: { path: join(companion, "alignfirst.json"), in: "companion", exists: true },
        portRange: { first: 28100, last: 28199 },
        hasDevServer: true,
        registryDir: join(companion, ".local-wt/workspace-registry"),
      },
    });
    expect(report.workspace.runtimeDir).toBe(report.locations.workspaceRuntime.path);
    expect(report.workspace.runtimeDir).toMatch(/\/worktrees\/app-[a-f0-9]{64}$/);
    expect(existsSync(join(companion, ".local-wt"))).toBe(false);
    expect(existsSync(join(project, ".local-wt"))).toBe(false);
  });

  it("reports a profile-only selection without creating a companion", async () => {
    const home = temp();
    configureGit(home);
    const project = join(home, "app");
    initRepository(project);
    writeRegistry(home, { projects: { "~/app": { aligndev: { profile: "work" } } } });
    const before = readdirSync(project);
    const result = await runMain(["config", "--json"], { cwd: project, home });
    expect(JSON.parse(result.stdout)).toMatchObject({
      companion: null,
      aligndev: { profile: "work" },
    });
    expect(readdirSync(project)).toEqual(before);
    expect(readdirSync(join(home, ".alignfirst", "companions"))).toEqual(["registry.json"]);
  });

  it.each(["alignfirst"])("reports invalid %s as a CLI error", async (family) => {
    const cwd = temp();
    writeFileSync(join(cwd, `${family}.json`), "{");
    const result = await runMain(["config", "--json"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Invalid ${join(cwd, `${family}.json`)}`);
    expect(result.stdout).toBe("");
  });

  it("reports invalid companion settings", async () => {
    const home = temp();
    writeRegistry(home, { projects: { "~/app": { aligndev: { profile: false } } } });
    const result = await runMain(["config", "--json"], { cwd: home, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aligndev.profile");
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
