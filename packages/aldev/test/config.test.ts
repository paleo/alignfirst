import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import {
  loadConfig,
  requireCodeConfig,
  requirePlatform,
  requireProjectsRoot,
} from "../src/config.js";
import { makeSink, writeConfig } from "./helpers.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aldev-config-"));
  homes.push(home);
  return home;
}

function configPathOf(home: string): string {
  return join(home, ".config", "alignfirst", "aldev.config.json");
}

function writeRawConfig(home: string, content: string): string {
  const path = configPathOf(home);
  mkdirSync(join(home, ".config", "alignfirst"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("loadConfig", () => {
  it("returns only the path when the file is absent", () => {
    const home = makeHome();
    expect(loadConfig(home)).toEqual({ path: configPathOf(home) });
  });

  it("reads every key and applies the code defaults", () => {
    const home = makeHome();
    const path = writeConfig(home, {
      platform: "openclaw",
      projectsRoot: "/srv/projects",
      code: { agent: "codex" },
    });
    expect(loadConfig(home)).toEqual({
      path,
      platform: "openclaw",
      projectsRoot: { path: "/srv/projects", written: "/srv/projects" },
      code: { agent: "codex", skipPermissions: false, unset: [] },
    });
  });

  it("keeps the configured code options", () => {
    const home = makeHome();
    writeConfig(home, {
      code: { agent: "claude", models: ["opus"], skipPermissions: true, unset: ["TOKEN"] },
    });
    expect(loadConfig(home).code).toEqual({
      agent: "claude",
      models: ["opus"],
      skipPermissions: true,
      unset: ["TOKEN"],
    });
  });

  it("expands ~/ against home and resolves a relative root against the config directory", () => {
    const home = makeHome();
    writeConfig(home, { projectsRoot: "~/projects" });
    expect(loadConfig(home).projectsRoot).toEqual({
      path: join(home, "projects"),
      written: "~/projects",
    });
    writeConfig(home, { projectsRoot: "../../work" });
    expect(loadConfig(home).projectsRoot).toEqual({
      path: join(home, "work"),
      written: "../../work",
    });
  });

  it("rejects an unreadable file, naming its path", () => {
    const home = makeHome();
    mkdirSync(configPathOf(home), { recursive: true });
    expect(() => loadConfig(home)).toThrow(`Error: invalid aldev config ${configPathOf(home)}: `);
  });

  it("rejects invalid JSON, naming its path", () => {
    const home = makeHome();
    const path = writeRawConfig(home, "{ platform: openclaw }");
    expect(() => loadConfig(home)).toThrow(`Error: invalid aldev config ${path}: `);
  });

  it.each([
    ["an unknown top-level key", { platfrom: "openclaw" }, "platfrom"],
    ["an unknown code key", { code: { agent: "claude", model: "opus" } }, "model"],
    ["an invalid agent", { code: { agent: "gemini" } }, "code.agent"],
    ["a missing agent", { code: { models: ["opus"] } }, "code.agent"],
    ["an invalid platform", { platform: "slack" }, "platform"],
  ])("rejects %s", (_name, config, problem) => {
    const home = makeHome();
    const path = writeConfig(home, config);
    let message = "";
    try {
      loadConfig(home);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(new RegExp(`^Error: invalid aldev config ${escapeRegExp(path)}: `));
    expect(message).toContain(problem);
    expect(message).not.toContain("\n");
  });
});

describe("required keys", () => {
  it("names the key and the file path, whether the file is present or absent", () => {
    for (const present of [true, false]) {
      const home = makeHome();
      if (present) writeConfig(home, {});
      const config = loadConfig(home);
      const suffix = `is missing from the aldev config ${configPathOf(home)}.`;
      expect(() => requirePlatform(config)).toThrow(
        `Error: platform ${suffix} Available platforms: openclaw.`,
      );
      expect(() => requireProjectsRoot(config)).toThrow(`Error: projectsRoot ${suffix}`);
      expect(() => requireCodeConfig(config)).toThrow(`Error: code.agent ${suffix}`);
    }
  });
});

describe("a broken config through main", () => {
  it("fails the commands that load it and spares --help and --version", async () => {
    const home = makeHome();
    const path = writeRawConfig(home, "not json");
    for (const args of [["code", "status", "--no-ticket"], ["project", "list"], ["guide"]]) {
      const stderr = makeSink();
      const code = await main({ argv: ["node", "aldev", ...args], env: {}, home, stderr });
      expect(code).toBe(1);
      expect(stderr.text()).toContain(`Error: invalid aldev config ${path}: `);
    }
    for (const args of [["--help"], ["--version"]]) {
      const code = await main({
        argv: ["node", "aldev", ...args],
        env: {},
        home,
        stdout: makeSink(),
      });
      expect(code).toBe(0);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
