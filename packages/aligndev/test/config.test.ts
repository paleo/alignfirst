import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import type { QuotaReader } from "../src/code/quota.js";
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
  vi.restoreAllMocks();
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

function run(home: string, argv: string[], env: NodeJS.ProcessEnv = {}, quotaReader?: QuotaReader) {
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
    quotaReader,
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
    "ignores retired code.%s with manual conversion warnings",
    (field) => {
      const home = makeHome({ code: { [field]: "old" } });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadConfig(home).code).toEqual({});
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(new RegExp(`code.${field}.*code.profiles.*code.profile.*manual`)),
      );
    },
  );

  it.each([
    [{ platform: "other" }, "platform"],
    [{ code: { profile: "  " } }, "code.profile"],
    [{ code: { profiles: { " ": { agent: "pi" } } } }, "nonblank"],
    [profileConfig({ agent: "other" }), "agent"],
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

  it.each([null, "true", 1, [], {}])("rejects non-boolean defaults %j", (value) => {
    const home = makeHome(profileConfig({ agent: "pi", default: value }));
    expect(() => loadConfig(home)).toThrow(/code.profiles.*test.*default/);
    expect(() => loadConfig(home)).toThrow(join(home, ".alignfirst/aligndev.settings.json"));
  });

  it.each([{}, null, { claude: "a" }])("ignores every retired map value %j", (map) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome({
      code: {
        defaultProfiles: map,
        profiles: { a: { agent: "claude" }, b: { agent: "claude" } },
      },
    });
    const config = loadConfig(home);
    expect(config.code).not.toHaveProperty("defaultProfiles");
    expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" })).toThrow("multiple profiles");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /code.defaultProfiles is retired.*manually.*matching-agent.*default: true.*singleton.*keep profile names unchanged.*alignfirst-upgrade.md/,
      ),
    );
  });

  it("warns at every fixed settings shape, discards unknown values and preserves maps and bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome({
      unknownRoot: "private-value",
      code: {
        unknownCode: { nested: "private-value" },
        profiles: {
          "sk-secret-profile\n\u001b[31m": {
            agent: "pi",
            unknownProfile: ["private-value"],
            env: { CUSTOM: "private-value" },
            modelAliases: { custom: "private-value" },
            quota: { source: "none", unknownQuota: "private-value" },
          },
        },
      },
    });
    const path = join(home, ".alignfirst/aligndev.settings.json");
    const before = readFileSync(path);
    const config = loadConfig(home);
    const profile = config.code.profiles?.["sk-secret-profile\n\u001b[31m"];
    expect(profile).toEqual({
      agent: "pi",
      env: { CUSTOM: "private-value" },
      modelAliases: { custom: "private-value" },
      quota: { source: "none" },
    });
    expect(warn).toHaveBeenCalledTimes(4);
    const warnings = warn.mock.calls.flat().join("\n");
    for (const field of [
      "unknownRoot",
      "code.unknownCode",
      "code.profiles[<entry>].unknownProfile",
      "code.profiles[<entry>].quota.unknownQuota",
    ])
      expect(warnings).toContain(field);
    for (const text of ["private-value", "sk-secret-profile", "\u001b"])
      expect(warnings).not.toContain(text);
    expect(readFileSync(path)).toEqual(before);
  });

  it("escapes unusual unknown property names on one physical warning line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig(makeHome({ "bad\n\u001b\u0085\u202e\u{e0001}.key": "private-value" }));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('settings["bad\\n\\u001b\\u0085\\u202e\\udb40\\udc01.key"]'),
    );
    for (const character of ["\n", "\u001b", "\u0085", "\u202e", "\u{e0001}"])
      expect(warn.mock.calls[0]?.[0]).not.toContain(character);
  });

  it("still rejects invalid recognized values alongside stale properties", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      loadConfig(
        makeHome({
          stale: true,
          code: {
            defaultProfiles: {},
            profiles: { broken: { agent: "pi", default: "yes", stale: true } },
          },
        }),
      ),
    ).toThrow("default must be a boolean");
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
  ])("uses %s built-ins, matching singleton or per-agent preference", (agent, env) => {
    const home = makeHome();
    expect(resolveCodeConfig(loadConfig(home), env)).toMatchObject({ agent, profile: null });
    for (const flag of [undefined, false, true]) {
      writeConfig(home, { code: { profiles: { only: { agent, default: flag } } } });
      const config = loadConfig(home);
      expect(resolveCodeConfig(config, env)).toMatchObject({ agent, profile: "only" });
      expect(resolveCodeConfig(config, {})).toMatchObject({ agent, profile: "only" });
      expect(resolveCodeConfig(config, env, { recorded: undefined }).profile).toBe("only");
      expect(resolveCodeConfig(config, env, { recorded: null }).profile).toBeNull();
      expect(() => resolveCodeConfig(config, {}, { recorded: null })).toThrow("no coding agent");
      expect(() => resolveCodeConfig(config, { CLAUDECODE: "1", AI_AGENT: "pi" })).toThrow(
        "multiple coding agents",
      );
    }
    writeConfig(home, {
      code: {
        profiles: {
          preferred: { agent, default: true },
          other: { agent },
        },
      },
    });
    const config = loadConfig(home);
    expect(resolveCodeConfig(config, env).profile).toBe("preferred");
    expect(resolveCodeConfig(config, env, { recorded: null }).profile).toBeNull();
    expect(() => resolveCodeConfig(config, {})).toThrow("no coding agent");
  });

  it.each([
    ["claude", { CLAUDECODE: "1" }, "pi"],
    ["codex", { CODEX_THREAD_ID: "t" }, "claude"],
    ["pi", { AI_AGENT: "pi" }, "codex"],
  ])("never overrides detected %s with another agent's singleton", (agent, env, other) => {
    const config = loadConfig(
      makeHome({ code: { profiles: { other: { agent: other, default: true } } } }),
    );
    expect(resolveCodeConfig(config, env)).toMatchObject({ agent, profile: null });
  });

  it.each(["claude", "codex", "pi"])("explains same-agent %s ambiguity without values", (agent) => {
    const marker =
      agent === "claude"
        ? { CLAUDECODE: "1" }
        : agent === "codex"
          ? { CODEX_THREAD_ID: "t" }
          : { AI_AGENT: "pi" };
    for (const flag of [undefined, false]) {
      const config = loadConfig(
        makeHome({
          code: {
            profiles: {
              first: { agent, default: flag, env: { SECRET: "never-print-me" } },
              second: { agent, default: flag },
            },
          },
        }),
      );
      expect(() => resolveCodeConfig(config, marker)).toThrow(
        /first.*second.*--profile.*project.*code.profile.*default: true/,
      );
      expect(() => resolveCodeConfig(config, marker)).not.toThrow(/never-print-me/);
      expect(resolveCodeConfig(config, marker, { recorded: null }).profile).toBeNull();
    }
  });

  it.each([{ explicit: "first" }, { project: { profile: "first" } }, { recorded: "first" }, {}])(
    "rejects duplicate defaults even with named selection %j",
    (selection) => {
      const config = loadConfig(
        makeHome({
          code: {
            profile: "first",
            profiles: {
              first: { agent: "pi", default: true },
              second: { agent: "pi", default: true },
            },
          },
        }),
      );
      expect(() => resolveCodeConfig(config, {}, selection)).toThrow(
        /pi.*first.*second.*leave only one/,
      );
    },
  );

  it("keeps different model defaults for each detected agent", () => {
    const home = makeHome({
      code: {
        profiles: {
          claude: { agent: "claude", default: true, defaultModel: "opus" },
          codex: { agent: "codex", default: true, defaultModel: "sol" },
          pi: { agent: "pi", default: true, defaultModel: "openai/sol" },
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

  it("validates global references at resolution even with valid explicit selection", () => {
    const config = loadConfig(makeHome({ code: { profile: "missing", profiles: PROFILES } }));
    expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" })).toThrow("invalid aligndev config");
    expect(() => resolveCodeConfig(config, {}, { explicit: "explicit" })).toThrow("code.profile");
  });

  it.each([
    {},
    { CLAUDECODE: "1", AI_AGENT: "pi" },
    { CODEX_THREAD_ID: "t", PI_CODING_AGENT: "true" },
  ])("requires names rather than agent-kind defaults for absent/multiple detection %j", (env) => {
    const home = makeHome({
      code: {
        profiles: {
          claude: { agent: "claude", default: true, env: { SECRET: "never-print-me" } },
          codex: { agent: "codex", default: true },
          pi: { agent: "pi", default: true },
        },
      },
    });
    const config = loadConfig(home);
    expect(() => resolveCodeConfig(config, env)).toThrow(/--profile.*project.*code.profile/);
    expect(() => resolveCodeConfig(config, env)).not.toThrow(/default: true|never-print-me/);
    expect(() => resolveCodeConfig(config, env, { recorded: null })).toThrow("coding agent");
    for (const selection of [
      { explicit: "pi" },
      { project: { profile: "codex" } },
      { recorded: "claude" },
    ])
      expect(resolveCodeConfig(config, env, selection).profile).not.toBeNull();
    writeConfig(home, { code: { ...config.code, profile: "pi" } });
    expect(resolveCodeConfig(loadConfig(home), env).profile).toBe("pi");
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
  it.each([false, true])(
    "shares automatic singleton/preferred selection across commands: %s",
    async (multiple) => {
      const home = makeHome({
        code: {
          profiles: {
            inferred: {
              agent: "claude",
              default: multiple,
              configDir: "~/native",
              defaultModel: "opus",
            },
            ...(multiple ? { other: { agent: "claude" } } : {}),
          },
        },
      });
      for (const args of [
        ["code", "--help"],
        ["guide", "code"],
        ["code", "quota"],
      ]) {
        let calls = 0;
        const result = await run(home, args, { CLAUDECODE: "1" }, async (source, options) => {
          ++calls;
          expect(source).toBe("claude");
          expect(options.env.CLAUDE_CONFIG_DIR).toBe(join(home, "native"));
          return "synthetic limits";
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("inferred");
        expect(result.stdout).toContain("claude");
        expect(calls).toBe(args.includes("quota") ? 1 : 0);
      }
      expect(existsSync(join(home, ".plans"))).toBe(false);
      expect(existsSync(join(home, ".git"))).toBe(false);
    },
  );

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

  it.each([
    { profile: "deleted" },
    { defaultProfiles: {} },
    { profiles: { a: { agent: "pi", default: "bad" } } },
    { profiles: { a: { agent: "pi", default: true }, b: { agent: "pi", default: true } } },
  ])("keeps durable status independent of launch settings %j", async (code) => {
    const home = makeHome({ code });
    const result = await run(home, ["code", "status", "--no-ticket"]);
    expect(result.stderr).toContain("no session file");
    expect(result.stderr).not.toContain("missing profile");
    expect(result.stderr).not.toContain("invalid aligndev config");
    expect((await run(home, ["code", "status", "--help"])).code).toBe(0);
  });

  it("spares top-level help/version and status but rejects corrupt settings elsewhere", async () => {
    const home = makeHome({});
    writeFileSync(join(home, ".alignfirst/aligndev.settings.json"), "bad json");
    for (const args of [["--help"], ["--version"], ["code", "status", "--help"]]) {
      expect((await run(home, args)).code).toBe(0);
    }
    expect((await run(home, ["code", "status", "--no-ticket"])).stderr).toContain(
      "no session file",
    );
    for (const args of [
      ["code", "--help"],
      ["code", "quota"],
      ["code", "new", "-m", "go"],
      ["guide"],
      ["project", "list"],
    ]) {
      expect((await run(home, args)).stderr).toContain("invalid aligndev config");
    }
  });
});
