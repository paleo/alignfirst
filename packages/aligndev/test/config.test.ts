import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import {
  type CodingProfile,
  loadConfig,
  requireProjectsRoot,
  resolveCodeConfig,
} from "../src/config.js";
import { ALIGNFIRST_BIN, makeSink, writeSettings as writeConfig } from "./helpers.js";

const homes: string[] = [];
// biome-ignore lint/suspicious/noTemplateCurlyInString: Exercises literal environment values.
const LITERAL_ENV = "$HOME/${KEY} `echo x`";
const PROFILES = {
  global: { agent: "claude" },
  project: { agent: "codex" },
  recorded: { agent: "pi" },
  explicit: { agent: "claude" },
  detected: { agent: "codex" },
} satisfies Record<string, CodingProfile>;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(config?: object): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-config-"));
  homes.push(home);
  if (config !== undefined) writeConfig(home, config);
  return home;
}

function profileConfig(profile: object): object {
  return { code: { profile: "test", profiles: { test: profile } } };
}

function run(home: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = makeSink();
  const stderr = makeSink();
  return main({
    argv: ["node", "aligndev", ...argv],
    cwd: home,
    home,
    env: { HOME: home, ...env },
    alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
    stdout,
    stderr,
  }).then((code) => ({ code, stdout: stdout.text(), stderr: stderr.text() }));
}

describe("settings shape", () => {
  it("keeps absent settings and file settings distinct from effective defaults", () => {
    const home = makeHome();
    const config = loadConfig(home);
    expect(config).toEqual({
      path: join(home, ".alignfirst/aligndev.settings.json"),
      platform: "codingAgent",
      code: {},
    });
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" })).toMatchObject({
      profile: null,
      agent: "claude",
      skipPermissions: false,
      unset: [],
      childEnv: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    });
    expect(config.code).toEqual({});
  });

  it("retains platform and resolves projectsRoot independently", () => {
    const home = makeHome({ platform: "openclaw", projectsRoot: "~/projects" });
    expect(loadConfig(home).projectsRoot).toEqual({
      path: join(home, "projects"),
      written: "~/projects",
    });
    writeConfig(home, { projectsRoot: "../work" });
    expect(requireProjectsRoot(loadConfig(home)).path).toBe(join(home, "work"));
    expect(() => requireProjectsRoot(loadConfig(makeHome()))).toThrow("projectsRoot");
  });

  it("rejects the old filename only when the current file is absent", () => {
    const home = makeHome();
    mkdirSync(join(home, ".alignfirst"));
    writeFileSync(join(home, ".alignfirst/aligndev.config.json"), "{}");
    expect(() => loadConfig(home)).toThrow("was renamed");
    writeConfig(home, {});
    expect(loadConfig(home).code).toEqual({});
  });

  it.each(["agent", "defaultModel", "models", "skipPermissions", "unset"])(
    "rejects retired code.%s with conversion instructions",
    (field) => {
      const home = makeHome({ code: { [field]: "old" } });
      expect(() => loadConfig(home)).toThrow(
        new RegExp(`code.${field}.*code.profiles.*code.profile.*manual`),
      );
    },
  );

  it.each([
    [{ platfrom: "openclaw" }, "platfrom"],
    [{ platform: "other" }, "platform"],
    [{ code: { extra: 1 } }, "code.extra"],
    [{ code: { profile: "  " } }, "code.profile"],
    [{ code: { defaultProfiles: { other: "a" } } }, "other"],
    [{ code: { profiles: { " ": { agent: "pi" } } } }, "nonblank"],
    [profileConfig({ agent: "other" }), "agent"],
    [profileConfig({ agent: "pi", extra: 1 }), "extra"],
    [profileConfig({ agent: "pi", models: [" "] }), "models"],
    [profileConfig({ agent: "pi", defaultModel: " " }), "defaultModel"],
    [profileConfig({ agent: "pi", modelAliases: { " ": "x" } }), "modelAliases"],
    [profileConfig({ agent: "pi", modelAliases: { x: " " } }), "modelAliases"],
    [profileConfig({ agent: "pi", env: { "bad-name": "x" } }), "env"],
    [profileConfig({ agent: "pi", env: { X: 2 } }), "env"],
    [profileConfig({ agent: "pi", env: { X: "a\0b" } }), "NUL"],
    [profileConfig({ agent: "pi", unset: [" X"] }), "unset"],
    [profileConfig({ agent: "pi", env: { X: "x" }, unset: ["X"] }), "overlaps"],
    [profileConfig({ agent: "pi", configDir: "\0" }), "configDir"],
    [profileConfig({ agent: "pi", configDir: " " }), "configDir"],
    [
      profileConfig({ agent: "claude", configDir: "x", env: { CLAUDE_CONFIG_DIR: "y" } }),
      "conflicts",
    ],
    [profileConfig({ agent: "codex", configDir: "x", unset: ["CODEX_HOME"] }), "conflicts"],
    [
      profileConfig({ agent: "pi", configDir: "x", env: { PI_CODING_AGENT_DIR: "y" } }),
      "conflicts",
    ],
    [profileConfig({ agent: "pi", quota: { source: "pi" } }), "source"],
    [profileConfig({ agent: "pi", quota: { source: "none", unset: [] } }), "no other options"],
    [profileConfig({ agent: "pi", quota: { source: "none", env: {} } }), "no other options"],
    [profileConfig({ agent: "pi", quota: { source: "none", configDir: "x" } }), "no other options"],
    [
      profileConfig({
        agent: "pi",
        quota: { source: "codex", configDir: "x", unset: ["CODEX_HOME"] },
      }),
      "quota.configDir",
    ],
    [
      profileConfig({ agent: "pi", quota: { source: "claude", env: { X: "x" }, unset: ["X"] } }),
      "quota.unset",
    ],
  ])("rejects structural settings errors %j", (settings, field) => {
    const home = makeHome(settings);
    expect(() => loadConfig(home)).toThrow(field);
    expect(() => loadConfig(home)).toThrow(join(home, ".alignfirst/aligndev.settings.json"));
  });

  it("reports malformed and unreadable JSON without loading native state", () => {
    const home = makeHome({});
    const path = join(home, ".alignfirst/aligndev.settings.json");
    writeFileSync(path, "not json");
    expect(() => loadConfig(home)).toThrow(path);
    rmSync(path);
    mkdirSync(path);
    expect(() => loadConfig(home)).toThrow(path);
  });

  it("normalizes coding and quota directories but preserves literal values and typed quota", () => {
    const home = makeHome(
      profileConfig({
        agent: "pi",
        configDir: "~/pi dir",
        env: { LITERAL: LITERAL_ENV },
        quota: {
          source: "codex",
          configDir: "../quota",
          env: { ENDPOINT: "literal" },
          unset: ["TOKEN"],
        },
      }),
    );
    const config = loadConfig(home);
    const code = resolveCodeConfig(config, {});
    expect(code.configDir).toBe(join(home, "pi dir"));
    expect(code.childEnv.LITERAL).toBe(LITERAL_ENV);
    expect(code.quota).toEqual({
      source: "codex",
      configDir: join(home, "quota"),
      env: { ENDPOINT: "literal" },
      unset: ["TOKEN"],
    });
    expect(code.childEnv.ENDPOINT).toBeUndefined();
  });
});

describe("profile resolution", () => {
  it.each([
    [{ explicit: "explicit", project: { profile: "project" }, recorded: "recorded" }, "explicit"],
    [{ project: { profile: "project" }, recorded: "recorded" }, "project"],
    [{ recorded: "recorded" }, "recorded"],
    [{ recorded: null }, "global"],
    [{}, "global"],
  ])("uses exact precedence %j", (selection, expected) => {
    const config = loadConfig(makeHome({ code: { profile: "global", profiles: PROFILES } }));
    expect(resolveCodeConfig(config, {}, selection).profile).toBe(expected);
    expect(resolveCodeConfig(config, { CLAUDECODE: "1", AI_AGENT: "pi" }, selection).profile).toBe(
      expected,
    );
  });

  it.each([
    ["claude", { CLAUDECODE: "1" }],
    ["codex", { CODEX_THREAD_ID: "t" }],
    ["pi", { PI_CODING_AGENT: "true" }],
    ["pi", { AI_AGENT: "pi" }],
    ["pi", { PI_CODING_AGENT: "true", AI_AGENT: "pi" }],
  ])("uses %s built-ins or its mapped default", (agent, env) => {
    const home = makeHome();
    expect(resolveCodeConfig(loadConfig(home), env)).toMatchObject({ agent, profile: null });
    writeConfig(home, {
      code: {
        profiles: PROFILES,
        defaultProfiles: {
          [agent]: agent === "codex" ? "detected" : agent === "pi" ? "recorded" : "global",
        },
      },
    });
    expect(resolveCodeConfig(loadConfig(home), env).profile).not.toBeNull();
  });

  it("keeps different model defaults for each detected agent", () => {
    const home = makeHome({
      code: {
        defaultProfiles: { claude: "claude", codex: "codex", pi: "pi" },
        profiles: {
          claude: { agent: "claude", defaultModel: "opus" },
          codex: { agent: "codex", defaultModel: "sol" },
          pi: { agent: "pi", defaultModel: "openai/sol" },
        },
      },
    });
    const config = loadConfig(home);
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" }).defaultModel).toBe("opus");
    expect(resolveCodeConfig(config, { CODEX_THREAD_ID: "thread" }).defaultModel).toBe("sol");
    expect(resolveCodeConfig(config, { AI_AGENT: "pi" }).defaultModel).toBe("openai/sol");
  });

  it("detects only when needed and never falls through selected errors", () => {
    const config = loadConfig(makeHome({ code: { profile: "global", profiles: PROFILES } }));
    for (const selection of [
      { explicit: "missing" },
      { project: { profile: "missing" } },
      { recorded: "missing" },
      { explicit: " " },
    ]) {
      expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" }, selection)).toThrow(
        "missing profile",
      );
    }
    expect(
      resolveCodeConfig(config, {}, { explicit: "explicit", recorded: "deleted" }).profile,
    ).toBe("explicit");
    const absent = loadConfig(makeHome());
    expect(() => resolveCodeConfig(absent, {})).toThrow("no coding agent detected");
    expect(() => resolveCodeConfig(absent, { CLAUDECODE: "1", AI_AGENT: "pi" })).toThrow(
      "multiple coding agents",
    );
  });

  it.each([
    { profile: "missing" },
    { defaultProfiles: { claude: "missing" } },
    { defaultProfiles: { claude: "project" } },
  ])("validates configured references at launch resolution, not shape loading %j", (settings) => {
    const config = loadConfig(makeHome({ code: { ...settings, profiles: PROFILES } }));
    expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" })).toThrow("invalid aligndev config");
  });

  it("uses own properties for arbitrary profile and alias names", () => {
    const home = makeHome(
      JSON.parse(
        '{"code":{"profile":"__proto__","profiles":{"__proto__":{"agent":"pi","modelAliases":{"constructor":"openai/sol"}}}}}',
      ),
    );
    expect(resolveCodeConfig(loadConfig(home), {}).profile).toBe("__proto__");
    writeConfig(home, { code: { profile: "constructor", profiles: {} } });
    expect(() => resolveCodeConfig(loadConfig(home), {})).toThrow("missing profile");
  });

  it("validates defaults with the same accepted-name policy, without alias recursion", () => {
    const home = makeHome(
      profileConfig({ agent: "codex", defaultModel: "fast", modelAliases: { fast: "sol" } }),
    );
    expect(resolveCodeConfig(loadConfig(home), {}).defaultModel).toBe("fast");
    writeConfig(
      home,
      profileConfig({
        agent: "codex",
        defaultModel: "sol",
        models: ["fast"],
        modelAliases: { fast: "sol" },
      }),
    );
    expect(() => resolveCodeConfig(loadConfig(home), {})).toThrow("one of: fast");
    writeConfig(
      home,
      profileConfig({ agent: "pi", defaultModel: " provider/model:high ", models: [] }),
    );
    expect(resolveCodeConfig(loadConfig(home), {}).defaultModel).toBe(" provider/model:high ");
  });

  it("finalizes the child environment once without mutating caller or merging profiles", () => {
    const home = makeHome({
      code: {
        profile: "global",
        profiles: {
          global: { agent: "codex", env: { OTHER: "no" }, skipPermissions: true },
          selected: {
            agent: "claude",
            configDir: "../native",
            unset: ["TOKEN"],
            env: {
              KEEP: "profile",
              CLAUDE_CODE_SESSION_ID: "forbidden",
              CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "5",
            },
          },
        },
      },
    });
    const env = Object.freeze({
      TOKEN: "secret",
      KEEP: "caller",
      HOME: home,
      PI_MODEL: "parent",
      PATH: "/fixture/bin",
    });
    const config = loadConfig(home);
    const before = JSON.stringify(config);
    const code = resolveCodeConfig(config, env, { explicit: "selected" });
    expect(code.childEnv).toEqual({
      KEEP: "profile",
      HOME: home,
      PATH: "/fixture/bin",
      CLAUDE_CONFIG_DIR: join(home, "native"),
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
    });
    expect(env.TOKEN).toBe("secret");
    expect(JSON.stringify(config)).toBe(before);
    expect(code.skipPermissions).toBe(false);
  });
});

describe("command boundaries outside Git", () => {
  it.each([
    ["code", "--help"],
    ["code", "new", "--help"],
    ["code", "quota", "--help"],
    ["guide", "code"],
  ])("resolves --profile without detection or .plans %j", async (...args) => {
    const home = makeHome({ code: { profiles: PROFILES } });
    const result = await run(home, [...args, "--profile", "recorded"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("recorded");
    expect(result.stdout).toContain("pi");
    expect(existsSync(join(home, ".plans"))).toBe(false);
    expect(existsSync(join(home, ".alignfirst/companions"))).toBe(false);
    expect(() => requireProjectsRoot(loadConfig(home))).toThrow();
  });

  it.each([["guide", "project"], ["guide"], ["code", "status", "--no-ticket"]])(
    "rejects --profile on unrelated commands %j",
    async (...args) => {
      const result = await run(makeHome(), [...args, "--profile", "x"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("profile");
    },
  );

  it("keeps durable status independent of launch references and default policy", async () => {
    const home = makeHome({ code: { profile: "deleted", defaultProfiles: { pi: "missing" } } });
    const result = await run(home, ["code", "status", "--no-ticket"]);
    expect(result.stderr).toContain("no session file");
    expect(result.stderr).not.toContain("missing profile");
  });

  it("spares top-level help/version but rejects corrupt settings elsewhere", async () => {
    const home = makeHome({});
    writeFileSync(join(home, ".alignfirst/aligndev.settings.json"), "bad json");
    for (const args of [["--help"], ["--version"]]) expect((await run(home, args)).code).toBe(0);
    for (const args of [["code", "status", "--no-ticket"], ["guide"]])
      expect((await run(home, args)).stderr).toContain("invalid aligndev config");
  });
});
