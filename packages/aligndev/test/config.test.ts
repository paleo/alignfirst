import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { loadConfig, requireProjectsRoot, resolveCodeConfig } from "../src/config.js";
import { ALIGNFIRST_BIN, makeSink, writeConfig } from "./helpers.js";

const EXPLICIT = { platform: "openclaw", code: { agent: "claude" } };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-config-"));
  homes.push(home);
  return home;
}

// `main` options to render the playbook in `home`, with the repository's alignfirst.
function guideRun(home: string) {
  return {
    cwd: home,
    env: { HOME: home },
    home,
    alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
  };
}

function configPathOf(home: string): string {
  return join(home, ".alignfirst", "aligndev.config.json");
}

function writeRawConfig(home: string, content: string): string {
  const path = configPathOf(home);
  mkdirSync(join(home, ".alignfirst"), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("loadConfig", () => {
  it("applies the defaults when the file is absent", () => {
    const home = makeHome();
    expect(loadConfig(home)).toEqual({
      path: configPathOf(home),
      platform: "codingAgent",
      code: { skipPermissions: false, unset: [] },
    });
  });

  it("applies the defaults to the keys the file omits", () => {
    const home = makeHome();
    const path = writeConfig(home, { code: { models: ["opus"] } });
    expect(loadConfig(home)).toEqual({
      path,
      platform: "codingAgent",
      code: { models: ["opus"], skipPermissions: false, unset: [] },
    });
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

  it("accepts the codingAgent platform without projectsRoot", () => {
    const home = makeHome();
    const path = writeConfig(home, { platform: "codingAgent", code: { agent: "claude" } });
    expect(loadConfig(home)).toEqual({
      path,
      platform: "codingAgent",
      code: { agent: "claude", skipPermissions: false, unset: [] },
    });
  });

  it("keeps the configured code options", () => {
    const home = makeHome();
    writeConfig(home, {
      platform: "openclaw",
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
    writeConfig(home, { ...EXPLICIT, projectsRoot: "~/projects" });
    expect(loadConfig(home).projectsRoot).toEqual({
      path: join(home, "projects"),
      written: "~/projects",
    });
    writeConfig(home, { ...EXPLICIT, projectsRoot: "../work" });
    expect(loadConfig(home).projectsRoot).toEqual({
      path: join(home, "work"),
      written: "../work",
    });
  });

  it("rejects an unreadable file, naming its path", () => {
    const home = makeHome();
    mkdirSync(configPathOf(home), { recursive: true });
    expect(() => loadConfig(home)).toThrow(
      `Error: invalid aligndev config ${configPathOf(home)}: `,
    );
  });

  it("rejects invalid JSON, naming its path", () => {
    const home = makeHome();
    const path = writeRawConfig(home, "{ platform: openclaw }");
    expect(() => loadConfig(home)).toThrow(`Error: invalid aligndev config ${path}: `);
  });

  it.each([
    ["an unknown top-level key", { ...EXPLICIT, platfrom: "openclaw" }, "platfrom"],
    [
      "an unknown code key",
      { platform: "openclaw", code: { agent: "claude", model: "opus" } },
      "model",
    ],
    ["an invalid agent", { platform: "openclaw", code: { agent: "gemini" } }, "code.agent"],
    ["an invalid platform", { ...EXPLICIT, platform: "slack" }, "platform"],
  ])("rejects %s", (_name, config, problem) => {
    const home = makeHome();
    const path = writeConfig(home, config);
    let message = "";
    try {
      loadConfig(home);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(new RegExp(`^Error: invalid aligndev config ${escapeRegExp(path)}: `));
    expect(message).toContain(problem);
    expect(message).not.toContain("\n");
  });
});

describe("resolveCodeConfig", () => {
  it("keeps the configured agent without detection", () => {
    const home = makeHome();
    writeConfig(home, { code: { agent: "codex" } });
    expect(resolveCodeConfig(loadConfig(home), { CLAUDECODE: "1" }).agent).toBe("codex");
  });

  it.each([
    ["claude", { CLAUDECODE: "1" }],
    ["codex", { CODEX_THREAD_ID: "019a" }],
  ])("detects %s from its environment", (agent, env) => {
    expect(resolveCodeConfig(loadConfig(makeHome()), env).agent).toBe(agent);
  });

  it("fails when no coding agent is detected, naming the key and the path", () => {
    const home = makeHome();
    expect(() => resolveCodeConfig(loadConfig(home), { CLAUDECODE: "0" })).toThrow(
      "Error: no coding agent detected: run aligndev from Claude Code or Codex, or set " +
        `"code.agent" (claude or codex) in ${configPathOf(home)}.`,
    );
  });

  it("fails when both coding agents are detected", () => {
    const home = makeHome();
    const env = { CLAUDECODE: "1", CODEX_THREAD_ID: "019a" };
    expect(() => resolveCodeConfig(loadConfig(home), env)).toThrow(
      `Error: both Claude Code and Codex detected: set "code.agent" (claude or codex) in ${configPathOf(home)}.`,
    );
  });
});

describe("requireProjectsRoot", () => {
  it("names the key and the file path", () => {
    const home = makeHome();
    writeConfig(home, EXPLICIT);
    expect(() => requireProjectsRoot(loadConfig(home))).toThrow(
      `Error: projectsRoot is missing from the aligndev config ${configPathOf(home)}.`,
    );
  });
});

describe("an absent config through main", () => {
  it("runs guide and code with the detected agent", async () => {
    const home = makeHome();
    const env = { CODEX_THREAD_ID: "019a" };
    const stdout = makeSink();
    const code = await main({ argv: ["node", "aligndev", "code", "--help"], env, home, stdout });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("(selected: codex)");
    const guide = makeSink();
    expect(
      await main({
        ...guideRun(home),
        argv: ["node", "aligndev", "guide"],
        env: { ...env, HOME: home },
        stdout: guide,
      }),
    ).toBe(0);
    expect(guide.text()).toContain("in a coding-agent session");
  });

  it("fails only the agent-specific paths without a detected agent", async () => {
    const home = makeHome();
    for (const args of [
      ["guide", "code"],
      ["code", "--help"],
    ]) {
      const stderr = makeSink();
      const code = await main({ argv: ["node", "aligndev", ...args], env: {}, home, stderr });
      expect(code).toBe(1);
      expect(stderr.text()).toContain("Error: no coding agent detected");
    }
    for (const args of [["guide"], ["guide", "--help"], ["project", "--help"]]) {
      const stdout = makeSink();
      const code = await main({ ...guideRun(home), argv: ["node", "aligndev", ...args], stdout });
      expect(code).toBe(0);
    }
  });
});

describe("a broken config through main", () => {
  it("fails the commands that load it and spares --help and --version", async () => {
    const home = makeHome();
    const path = writeRawConfig(home, "not json");
    for (const args of [["code", "status", "--no-ticket"], ["project", "list"], ["guide"]]) {
      const stderr = makeSink();
      const code = await main({ argv: ["node", "aligndev", ...args], env: {}, home, stderr });
      expect(code).toBe(1);
      expect(stderr.text()).toContain(`Error: invalid aligndev config ${path}: `);
    }
    for (const args of [["--help"], ["--version"]]) {
      const code = await main({
        argv: ["node", "aligndev", ...args],
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
