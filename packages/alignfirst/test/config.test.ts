import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configureGit,
  initRepository,
  makeTempDir,
  packageVersion,
  runMain,
  writeRegistry,
} from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config command", () => {
  it("reports no config in text and JSON", async () => {
    const cwd = temp();
    expect((await runMain(["config"], { cwd })).stdout).toBe(
      [
        "Source: none",
        "CLI range: none",
        "Companion: none",
        `.alignfirst.json: ${join(cwd, ".alignfirst.json")} (project, missing)`,
        `.alignfirst-instructions: ${join(cwd, ".alignfirst-instructions")} (project, missing)`,
        `DEVELOPERS.md: ${join(cwd, "DEVELOPERS.md")} (project, missing)`,
        `docs: ${join(cwd, "docs")} (project, missing)`,
        `.plans: ${join(cwd, ".plans")} (project, missing)`,
        `_aligndev: ${join(cwd, ".plans")} (project, missing)`,
        "",
      ].join("\n"),
    );
    const report = JSON.parse((await runMain(["config", "--json"], { cwd })).stdout);
    expect(report).toMatchObject({ source: null, cli: null, config: null, companion: null });
    expect(report.locations.docs).toEqual({
      path: join(cwd, "docs"),
      in: "project",
      exists: false,
    });
  });

  it("reports a project config and its unsatisfied range without failing", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0", ticketIdPattern: "^\\d+$" }),
    );
    const result = await runMain(["config", "--json"], { cwd });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: "project",
      cli: { installed: packageVersion, range: ">=1.0.0", satisfied: false },
      config: { schemaVersion: 1, cli: ">=1.0.0", ticketIdPattern: "^\\d+$" },
    });
  });

  it("reports the companion, its config and every location", async () => {
    const home = temp();
    configureGit(home);
    const project = join(home, "projects", "app");
    initRepository(project);
    const companion = join(home, ".alignfirst", "companions", "projects_app");
    mkdirSync(companion, { recursive: true });
    writeFileSync(join(companion, ".alignfirst.json"), JSON.stringify({ schemaVersion: 1 }));
    writeRegistry(home, {
      paths: { "~/projects/app": { ".plans": false, _aligndev: true } },
    });

    const json = JSON.parse((await runMain(["config", "--json"], { cwd: project, home })).stdout);
    expect(json).toEqual({
      source: "companion",
      cli: null,
      config: { schemaVersion: 1 },
      companion: {
        dir: companion,
        exists: true,
        entries: ["~/projects/app"],
        flags: {
          ".alignfirst.json": "auto",
          ".alignfirst-instructions": "auto",
          "DEVELOPERS.md": "auto",
          docs: "auto",
          ".plans": false,
          _aligndev: true,
        },
      },
      locations: {
        ".alignfirst.json": {
          path: join(companion, ".alignfirst.json"),
          in: "companion",
          exists: true,
        },
        ".alignfirst-instructions": {
          path: join(companion, ".alignfirst-instructions"),
          in: "companion",
          exists: false,
        },
        "DEVELOPERS.md": { path: join(companion, "DEVELOPERS.md"), in: "companion", exists: false },
        docs: { path: join(companion, "docs"), in: "companion", exists: false },
        ".plans": { path: join(project, ".plans"), in: "project", exists: false },
        _aligndev: { path: join(companion, ".plans"), in: "companion", exists: false },
      },
    });

    const text = (await runMain(["config"], { cwd: project, home })).stdout;
    expect(text).toContain(`Source: companion\nCLI range: none\nCompanion: ${companion}\n`);
    expect(text).toContain(
      `.alignfirst.json: ${join(companion, ".alignfirst.json")} (companion)\n`,
    );
    expect(text).toContain(`.plans: ${join(project, ".plans")} (project, missing)\n`);

    rmSync(companion, { recursive: true });
    expect((await runMain(["config"], { cwd: project, home })).stdout).toContain(
      `Companion: ${companion} (missing)\n`,
    );
  });

  it("reports an invalid config as a CLI error", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, ".alignfirst.json"), "{");
    const result = await runMain(["config"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Invalid ${join(cwd, ".alignfirst.json")}`);
  });

  it("reports an invalid registry as a CLI error", async () => {
    const home = temp();
    writeRegistry(home, { root: "~/c", paths: {} });
    const result = await runMain(["config", "--json"], { cwd: home, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Invalid ${join(home, ".alignfirst", "companions", "registry.json")}: root must be removed`,
    );
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
