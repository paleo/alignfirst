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
        location: { path: join(cwd, "alignfirst-workspace.json"), in: "project", exists: false },
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

  it("reports validated metadata from the worktree root without executing or exposing commands", async () => {
    const cwd = temp();
    configureGit(cwd);
    initRepository(cwd);
    const nested = join(cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const sentinel = join(cwd, "executed");
    writeFileSync(
      join(cwd, "alignfirst.jsonc"),
      '{/* conventions */ "schemaVersion":1,"ticketIdPattern":"^TASK-\\\\d+$",}',
    );
    writeFileSync(
      join(cwd, "alignfirst-workspace.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
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
    const result = await runMain(["config", "--json"], { cwd: nested });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "project",
      workspace: {
        location: { path: join(cwd, "alignfirst-workspace.jsonc"), in: "project", exists: true },
        schemaVersion: 1,
        portRange: { first: 8100, last: 8199 },
        hasDevServer: true,
      },
      locations: { alignfirst: { path: join(cwd, "alignfirst.jsonc") } },
    });
    expect(result.stdout).not.toContain("PRIVATE");
    expect(result.stdout).not.toContain("touch");
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(cwd, ".local-wt"))).toBe(false);
  });

  it("selects conventions independently from the branch-local manifest and profile", async () => {
    const { root, home, project, companion } = makeCompanionProject(
      { alignfirst: "companion" },
      "work",
    );
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(join(companion, "alignfirst.jsonc"), '{"schemaVersion":1}');
    writeFileSync(join(companion, "alignfirst-workspace.json"), '{"INVALID":true}');
    const result = await runMain(["config", "--json"], { cwd: project, home });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "companion",
      aligndev: { profile: "work" },
      companion: { dir: companion, items: { alignfirst: "companion" } },
      locations: {
        alignfirst: { path: join(companion, "alignfirst.jsonc"), in: "companion", exists: true },
      },
      workspace: { location: { path: join(project, "alignfirst-workspace.json"), exists: false } },
    });
    const text = await runMain(["config"], { cwd: project, home });
    expect(text.stdout).toContain('Companion items: "alignfirst": "companion"');
    expect(text.stdout).toContain("AlignDev profile: work");
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

  it.each(["alignfirst", "alignfirst-workspace"])(
    "reports invalid %s as a CLI error",
    async (family) => {
      const cwd = temp();
      writeFileSync(join(cwd, `${family}.json`), "{");
      const result = await runMain(["config", "--json"], { cwd });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Invalid ${join(cwd, `${family}.json`)}`);
      expect(result.stdout).toBe("");
    },
  );

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
