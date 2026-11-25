import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { describeNativeStorage } from "../src/code/native-context.js";
import type { QuotaReader } from "../src/code/quota.js";
import { resolveAssistantHarness } from "../src/assistant-harness.js";
import {
  type CodingProfile,
  loadConfig,
  type ProfileSelection,
  requireProjectsRoot,
  resolveCodeConfig,
} from "../src/config.js";
import { ALIGNFIRST_BIN, makeSink, writeSettings as writeConfig } from "./helpers.js";

const homes: string[] = [];
// biome-ignore lint/suspicious/noTemplateCurlyInString: Exercises literal environment values.
const LITERAL_ENV = "$HOME/${KEY} `echo x`";
const PROFILES = {
  global: { harness: "claude" },
  project: { harness: "codex" },
  recorded: { harness: "pi" },
  explicit: { harness: "claude" },
  detected: { harness: "codex" },
} satisfies Record<string, CodingProfile>;

interface ReferenceCase {
  selection: ProfileSelection;
  profiles?: Record<string, object>;
  fallbackProfile?: string;
}

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
  return { code: { fallbackProfile: "test", profiles: { test: profile } } };
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
    const config = loadConfig(home, "alignfirst");
    expect(config).toEqual({
      path: join(home, ".alignfirst/aligndev.settings.json"),
      code: {},
    });
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" })).toMatchObject({
      profile: null,
      harness: "claude",
      skipPermissions: false,
      unset: [],
      childEnv: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    });
    expect(config.code).toEqual({});
  });

  it("resolves projectsRoot", () => {
    const home = makeHome({ projectsRoot: "~/projects" });
    expect(loadConfig(home, "alignfirst").projectsRoot).toEqual({
      path: join(home, "projects"),
      written: "~/projects",
    });
    writeConfig(home, { projectsRoot: "../work" });
    expect(requireProjectsRoot(loadConfig(home, "alignfirst")).path).toBe(join(home, "work"));
    expect(() => requireProjectsRoot(loadConfig(makeHome(), "alignfirst"))).toThrow(Error);
  });

  it.each(['{"secret":"private-json-value" trailing}', "private-json-value"])(
    "sanitizes malformed JSON without rewriting input: %s",
    (text) => {
      const home = makeHome({});
      const path = join(home, ".alignfirst/aligndev.settings.json");
      writeFileSync(path, text);
      expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
      expect(() => loadConfig(home, "alignfirst")).not.toThrow("private-json-value");
      expect(readFileSync(path, "utf8")).toBe(text);
    },
  );

  it("retains filesystem diagnostics for unreadable settings", () => {
    const home = makeHome();
    const path = join(home, ".alignfirst/aligndev.settings.json");
    mkdirSync(path, { recursive: true });
    expect(() => loadConfig(home, "alignfirst")).toThrow("EISDIR");
  });

  it("rejects the old filename only when the current file is absent", () => {
    const home = makeHome();
    mkdirSync(join(home, ".alignfirst"));
    writeFileSync(join(home, ".alignfirst/aligndev.config.json"), "{}");
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
    writeConfig(home, {});
    expect(loadConfig(home, "alignfirst").code).toEqual({});
  });

  it.each(["agent", "defaultModel", "models", "skipPermissions", "unset"])(
    "ignores retired code.%s",
    (field) => {
      const home = makeHome({ code: { [field]: "old" } });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadConfig(home, "alignfirst").code).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ platform: "openclaw" }],
    [{ code: { profile: "x", profiles: { x: { harness: "pi" } } } }],
    [profileConfig({ harness: "pi", agent: "pi" })],
    [{ portRange: { first: 28000, last: 28599 } }],
  ])(
    "ignores the retired platform, portRange, code.profile and profile agent with a warning %j",
    (settings) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadConfig(makeHome(settings), "alignfirst");
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("requires a profile harness", () => {
    const home = makeHome(profileConfig({}));
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
  });

  it.each([
    [
      { agent: "claude", defaultModel: "opus" },
      { harness: "claude", defaultModel: "opus" },
    ],
    [
      { agent: "openclaw", defaultAgentProfile: "x" },
      { harness: "openclaw", defaultAgentProfile: "x" },
    ],
  ])("reads a profile agent without harness as harness, with a warning %j", (profile, read) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome({ code: { profiles: { x: { harness: "pi" }, legacy: profile } } });
    expect(loadConfig(home, "alignfirst").code.profiles?.legacy).toEqual(read);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/code\.profiles\[<entry>\]\.agent.*"harness"/);
  });

  it("names agent when its value is not a harness", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome(profileConfig({ agent: "other" }));
    expect(() => loadConfig(home, "alignfirst")).toThrow(/\.agent must be one of/);
  });

  it("accepts an openclaw profile with its own keys and warns on unknown ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const openclaw = { harness: "openclaw", defaultAgentProfile: "work", disabled: false };
    const home = makeHome({
      code: { profiles: { assistant: { ...openclaw, stale: 1 }, work: { harness: "pi" } } },
    });
    expect(loadConfig(home, "alignfirst").code.profiles?.assistant).toEqual(openclaw);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    { default: true },
    { configDir: null },
    { models: [] },
    { defaultEffort: "high" },
    { env: {} },
    { quota: { source: "none" } },
  ])("rejects coding-agent keys on an openclaw profile %j", (extra) => {
    const home = makeHome({
      code: {
        profiles: { assistant: { harness: "openclaw", defaultAgentProfile: "x", ...extra } },
      },
    });
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
  });

  it.each([
    [{ projectsRoot: null }, "projectsRoot"],
    [profileConfig({ harness: "pi", configDir: 1 }), "configDir"],
    [profileConfig({ harness: "pi", quota: { source: "codex", configDir: false } }), "configDir"],
    [profileConfig({ harness: "pi", quota: { source: "codex", configDir: " " } }), "configDir"],
    [profileConfig({ harness: "pi", quota: { source: "codex", configDir: "a\0b" } }), "configDir"],
    [{ code: { fallbackProfile: "  " } }, "code.fallbackProfile"],
    [{ code: { profiles: { " ": { harness: "pi" } } } }, "nonblank"],
    [profileConfig({ harness: "other" }), "harness"],
    [profileConfig({ harness: "pi", defaultAgentProfile: " " }), "defaultAgentProfile"],
    [profileConfig({ harness: "pi", disabled: "yes" }), "disabled"],
    [profileConfig({ harness: "pi", disabled: true, configDir: 1 }), "disabled shape"],
    [
      { code: { profiles: { assistant: { harness: "openclaw" } } } },
      "openclaw defaultAgentProfile",
    ],
    [profileConfig({ harness: "pi", models: [" "] }), "models"],
    [profileConfig({ harness: "pi", defaultModel: " " }), "defaultModel"],
    [profileConfig({ harness: "pi", efforts: [" "] }), "efforts"],
    [profileConfig({ harness: "pi", defaultEffort: " " }), "defaultEffort"],
    [profileConfig({ harness: "pi", modelAliases: { " ": "x" } }), "modelAliases"],
    [profileConfig({ harness: "pi", modelAliases: { x: " " } }), "modelAliases"],
    [profileConfig({ harness: "pi", env: { "bad-name": "x" } }), "env"],
    [profileConfig({ harness: "pi", env: { X: 2 } }), "env"],
    [profileConfig({ harness: "pi", env: { X: "a\0b" } }), "NUL"],
    [profileConfig({ harness: "pi", unset: [" X"] }), "unset"],
    [profileConfig({ harness: "pi", env: { X: "x" }, unset: ["X"] }), "overlaps"],
    [profileConfig({ harness: "pi", configDir: "\0" }), "configDir"],
    [profileConfig({ harness: "pi", configDir: " " }), "configDir"],
    [
      profileConfig({ harness: "claude", configDir: "x", env: { CLAUDE_CONFIG_DIR: "y" } }),
      "conflicts",
    ],
    [profileConfig({ harness: "codex", configDir: "x", unset: ["CODEX_HOME"] }), "conflicts"],
    [
      profileConfig({ harness: "pi", configDir: "x", env: { PI_CODING_AGENT_DIR: "y" } }),
      "conflicts",
    ],
    [profileConfig({ harness: "pi", quota: { source: "pi" } }), "source"],
    [profileConfig({ harness: "pi", quota: { source: "none", unset: [] } }), "no other options"],
    [profileConfig({ harness: "pi", quota: { source: "none", env: {} } }), "no other options"],
    [
      profileConfig({ harness: "pi", quota: { source: "none", configDir: "x" } }),
      "no other options",
    ],
    [
      profileConfig({ harness: "pi", quota: { source: "none", configDir: null } }),
      "no other options",
    ],
    [
      profileConfig({
        harness: "pi",
        quota: { source: "codex", configDir: "x", unset: ["CODEX_HOME"] },
      }),
      "quota.configDir",
    ],
    [
      profileConfig({ harness: "pi", quota: { source: "claude", env: { X: "x" }, unset: ["X"] } }),
      "quota.unset",
    ],
  ])("rejects structural settings errors %j (%s)", (settings) => {
    const home = makeHome(settings);
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["codex", "CODEX_HOME"],
    ["pi", "PI_CODING_AGENT_DIR"],
  ] as const)("rejects null %s directory conflicts in env and unset", (agent, variable) => {
    for (const conflict of [{ env: { [variable]: "private" } }, { unset: [variable] }]) {
      const home = makeHome(profileConfig({ harness: agent, configDir: null, ...conflict }));
      expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
      if (agent === "pi") continue;
      writeConfig(
        home,
        profileConfig({ harness: "pi", quota: { source: agent, configDir: null, ...conflict } }),
      );
      expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
    }
  });

  it.each([null, "true", 1, [], {}])("rejects non-boolean defaults %j", (value) => {
    const home = makeHome(profileConfig({ harness: "pi", default: value }));
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
  });

  it.each([{}, null, { claude: "a" }])("ignores every retired map value %j", (map) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome({
      code: {
        defaultProfiles: map,
        profiles: { a: { harness: "claude" }, b: { harness: "claude" } },
      },
    });
    const config = loadConfig(home, "alignfirst");
    expect(config.code).not.toHaveProperty("defaultProfiles");
    expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" })).toThrow(Error);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, "alignfirst"],
    [{ npm_config_user_agent: "pnpm/10.0.0", npm_command: "dlx" }, "pnpm dlx alignfirst"],
    [{ npm_config_user_agent: "npm/11.0.0", npm_command: "exec" }, "npx -y alignfirst"],
  ])(
    "points the retired map at the upgrade guide through the caller's form %j",
    async (env, form) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const home = makeHome({ code: { defaultProfiles: {} } });
      await run(home, ["project", "--help"], env);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `See "Convert AlignDev Profile Defaults" in \`${form} setup guide upgrade\`.`,
        ),
      );
    },
  );

  it("warns at every fixed settings shape,discards unknown values and preserves maps and bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = makeHome({
      unknownRoot: "private-value",
      code: {
        unknownCode: { nested: "private-value" },
        profiles: {
          "sk-secret-profile\n\u001b[31m": {
            harness: "pi",
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
    const config = loadConfig(home, "alignfirst");
    const profile = config.code.profiles?.["sk-secret-profile\n\u001b[31m"];
    expect(profile).toEqual({
      harness: "pi",
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
    loadConfig(makeHome({ "bad\n\u001b\u0085\u202e\u{e0001}.key": "private-value" }), "alignfirst");
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
            profiles: { broken: { harness: "pi", default: "yes", stale: true } },
          },
        }),
        "alignfirst",
      ),
    ).toThrow(Error);
  });

  it("normalizes coding and quota directories but preserves literal values and typed quota", () => {
    const home = makeHome(
      profileConfig({
        harness: "pi",
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
    const config = loadConfig(home, "alignfirst");
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

describe("assistant's harness", () => {
  it.each([
    [{ ALIGNDEV_ASSISTANT_HARNESS: "pi", CLAUDECODE: "1", OPENCLAW_SHELL: "exec" }, "pi"],
    [{ ALIGNDEV_ASSISTANT_HARNESS: "", CLAUDECODE: "1" }, "claude"],
    [{ CODEX_THREAD_ID: "t", OPENCLAW_SHELL: "exec" }, "codex"],
    [{ OPENCLAW_SHELL: "exec" }, "openclaw"],
    [{ CLAUDECODE: "1", AI_AGENT: "pi", OPENCLAW_SHELL: "exec" }, undefined],
    [{ OPENCLAW_SHELL: "other" }, undefined],
    [{}, undefined],
  ])("resolves %j to %s", (env, harness) => {
    expect(resolveAssistantHarness(env).harness).toBe(harness);
  });

  it("rejects an invalid ALIGNDEV_ASSISTANT_HARNESS even before a named selection", () => {
    const config = loadConfig(makeHome({ code: { profiles: PROFILES } }), "alignfirst");
    const env = { ALIGNDEV_ASSISTANT_HARNESS: "codingAgent" };
    expect(() => resolveCodeConfig(config, env, { explicit: "explicit" })).toThrow(Error);
  });
});

describe("profile resolution", () => {
  it.each([
    [{ explicit: "explicit", project: { profile: "project" }, recorded: "recorded" }, "explicit"],
    [{ project: { profile: "project" }, recorded: "recorded" }, "project"],
    [{ recorded: "recorded" }, "recorded"],
    [{}, "global"],
  ])("uses exact precedence %j", (selection, expected) => {
    const config = loadConfig(
      makeHome({ code: { fallbackProfile: "global", profiles: PROFILES } }),
      "alignfirst",
    );
    for (const env of [{}, { CLAUDECODE: "1", AI_AGENT: "pi" }, { OPENCLAW_SHELL: "exec" }])
      expect(resolveCodeConfig(config, env, selection).profile).toBe(expected);
  });

  it.each([
    [undefined, undefined, true],
    [undefined, "/elsewhere", true],
    [null, undefined, true],
    [null, "", true],
    [null, "~/.claude", false],
    ["~/native", "~/native/", true],
    ["~/native", "~/other/../native", true],
    ["~/native", undefined, false],
    ["~/native", "~/other", false],
  ])("matches configDir %j against a session variable %j: %s", (configDir, variable, matches) => {
    const home = makeHome({ code: { profiles: { own: { harness: "claude", configDir } } } });
    const env = {
      CLAUDECODE: "1",
      ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable.replace("~", home) }),
    };
    const code = resolveCodeConfig(loadConfig(home, "alignfirst"), env);
    expect(code.profile).toBe(matches ? "own" : null);
    expect(code.harness).toBe("claude");
  });

  it.each([
    ["~/elsewhere", "anywhere"],
    [undefined, "unset"],
    ["~/work", "work"],
  ])("prefers an exact configDir match over a default omitted one: %j", (variable, expected) => {
    const home = makeHome({
      code: {
        profiles: {
          anywhere: { harness: "claude", default: true },
          unset: { harness: "claude", configDir: null },
          work: { harness: "claude", configDir: "~/work" },
        },
      },
    });
    const env = {
      CLAUDECODE: "1",
      ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable.replace("~", home) }),
    };
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), env).profile).toBe(expected);
  });

  it.each([
    ["codex", "CODEX_HOME", { CODEX_THREAD_ID: "t" }],
    ["pi", "PI_CODING_AGENT_DIR", { AI_AGENT: "pi" }],
  ] as const)("reads the %s session's own directory variable", (harness, variable, marker) => {
    const home = makeHome({ code: { profiles: { own: { harness, configDir: "~/native" } } } });
    const config = loadConfig(home, "alignfirst");
    const env = { ...marker, [variable]: join(home, "native") };
    expect(resolveCodeConfig(config, env).profile).toBe("own");
    expect(
      resolveCodeConfig(config, { ...marker, CLAUDE_CONFIG_DIR: join(home, "native") }).profile,
    ).toBeNull();
  });

  it.each(["claude", "codex", "pi"] as const)(
    "breaks a tie between %s candidates only with default: true, without leaking values",
    (harness) => {
      const marker =
        harness === "claude"
          ? { CLAUDECODE: "1" }
          : harness === "codex"
            ? { CODEX_THREAD_ID: "t" }
            : { AI_AGENT: "pi" };
      for (const flag of [undefined, false]) {
        const config = loadConfig(
          makeHome({
            code: {
              profiles: {
                first: { harness, default: flag, env: { SECRET: "never-print-me" } },
                second: { harness, default: flag },
              },
            },
          }),
          "alignfirst",
        );
        expect(() => resolveCodeConfig(config, marker)).toThrow(Error);
        expect(() => resolveCodeConfig(config, marker)).not.toThrow(/never-print-me/);
        expect(resolveCodeConfig(config, marker, { explicit: "second" }).profile).toBe("second");
      }
      const config = loadConfig(
        makeHome({
          code: { profiles: { first: { harness }, second: { harness, default: true } } },
        }),
        "alignfirst",
      );
      expect(resolveCodeConfig(config, marker).profile).toBe("second");
    },
  );

  it("follows the assistant profile's defaultAgentProfile once", () => {
    const config = loadConfig(
      makeHome({
        code: {
          profiles: {
            assistant: { harness: "claude", defaultAgentProfile: "worker" },
            worker: { harness: "codex", defaultAgentProfile: "other" },
            other: { harness: "pi" },
          },
        },
      }),
      "alignfirst",
    );
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" })).toMatchObject({
      profile: "worker",
      harness: "codex",
    });
  });

  it.each([
    [{ CLAUDECODE: "1" }, "claude"],
    [{ CODEX_THREAD_ID: "t" }, "codex"],
    [{ ALIGNDEV_ASSISTANT_HARNESS: "pi" }, "pi"],
  ])(
    "uses the built-ins of %j without an assistant's profile, ignoring the fallback",
    (env, harness) => {
      const config = loadConfig(
        makeHome({
          code: {
            fallbackProfile: "fallback",
            profiles: { fallback: { harness: harness === "claude" ? "codex" : "claude" } },
          },
        }),
        "alignfirst",
      );
      expect(resolveCodeConfig(config, env)).toMatchObject({ profile: null, harness });
    },
  );

  it("delegates an openclaw session to its openclaw profile, else to the fallback", () => {
    const home = makeHome({
      code: {
        fallbackProfile: "fallback",
        profiles: {
          assistant: { harness: "openclaw", defaultAgentProfile: "service" },
          service: { harness: "pi" },
          fallback: { harness: "claude" },
        },
      },
    });
    const env = { OPENCLAW_SHELL: "exec" };
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), env).profile).toBe("service");
    const config = loadConfig(home, "alignfirst");
    const disabled = config.code.profiles?.assistant;
    if (disabled === undefined) throw new Error("missing fixture profile");
    disabled.disabled = true;
    expect(resolveCodeConfig(config, env).profile).toBe("fallback");
  });

  it.each([{ OPENCLAW_SHELL: "exec" }, {}, { CLAUDECODE: "1", AI_AGENT: "pi" }])(
    "requires code.fallbackProfile or --profile without a recognized assistant's profile %j",
    (env) => {
      const home = makeHome({ code: { profiles: {} } });
      expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), env)).toThrow(Error);
      writeConfig(home, { code: { profiles: { only: { harness: "pi" } } } });
      expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), env)).toThrow(
        '"fallbackProfile": "only"',
      );
      writeConfig(home, {
        code: { profiles: { first: { harness: "pi" }, second: { harness: "claude" } } },
      });
      expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), env)).toThrow(
        /"first", "second"/,
      );
    },
  );

  it.each<[string, (target: string) => ReferenceCase]>([
    ["--profile", (target) => ({ selection: { explicit: target } })],
    ["project", (target) => ({ selection: { project: { profile: target } } })],
    ["recorded", (target) => ({ selection: { recorded: target } })],
    [
      "defaultAgentProfile",
      (target) => ({
        selection: { explicit: "ok" },
        profiles: { referrer: { harness: "pi", defaultAgentProfile: target } },
      }),
    ],
    ["fallbackProfile", (target) => ({ selection: { explicit: "ok" }, fallbackProfile: target })],
  ])("fails a %s reference to a missing, disabled or openclaw profile", (_origin, build) => {
    const messages = new Set<string>();
    for (const target of ["missing", "off", "assistant"]) {
      const { selection, profiles, fallbackProfile } = build(target);
      const config = loadConfig(
        makeHome({
          code: {
            fallbackProfile,
            profiles: {
              ok: { harness: "claude" },
              off: { harness: "claude", disabled: true },
              assistant: { harness: "openclaw", defaultAgentProfile: "ok" },
              ...profiles,
            },
          },
        }),
        "alignfirst",
      );
      try {
        resolveCodeConfig(config, {}, selection);
        expect.fail(`expected ${target} to fail`);
      } catch (error) {
        messages.add(String(error));
      }
    }
    expect(messages.size).toBe(3);
  });

  it("checks neither references nor duplicates inside disabled profiles", () => {
    const config = loadConfig(
      makeHome({
        code: {
          profiles: {
            ok: { harness: "claude", default: true },
            off: { harness: "claude", default: true, disabled: true, defaultAgentProfile: "gone" },
            assistant: { harness: "openclaw", defaultAgentProfile: "ok" },
            retired: { harness: "openclaw", defaultAgentProfile: "gone", disabled: true },
          },
        },
      }),
      "alignfirst",
    );
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" }).profile).toBe("ok");
  });

  it("rejects two enabled openclaw profiles even with a named selection", () => {
    const config = loadConfig(
      makeHome({
        code: {
          profiles: {
            ok: { harness: "claude" },
            first: { harness: "openclaw", defaultAgentProfile: "ok" },
            second: { harness: "openclaw", defaultAgentProfile: "ok" },
          },
        },
      }),
      "alignfirst",
    );
    expect(() => resolveCodeConfig(config, {}, { explicit: "ok" })).toThrow(Error);
  });

  it.each([{ explicit: "first" }, { project: { profile: "first" } }, { recorded: "first" }, {}])(
    "rejects duplicate defaults even with named selection %j",
    (selection) => {
      const config = loadConfig(
        makeHome({
          code: {
            fallbackProfile: "first",
            profiles: {
              first: { harness: "pi", default: true },
              second: { harness: "pi", default: true },
            },
          },
        }),
        "alignfirst",
      );
      expect(() => resolveCodeConfig(config, {}, selection)).toThrow(Error);
    },
  );

  it("keeps different model defaults for each detected agent", () => {
    const home = makeHome({
      code: {
        profiles: {
          claude: { harness: "claude", default: true, defaultModel: "opus" },
          codex: { harness: "codex", default: true, defaultModel: "sol" },
          pi: { harness: "pi", default: true, defaultModel: "openai/sol" },
        },
      },
    });
    const config = loadConfig(home, "alignfirst");
    expect(resolveCodeConfig(config, { CLAUDECODE: "1" }).defaultModel).toBe("opus");
    expect(resolveCodeConfig(config, { CODEX_THREAD_ID: "thread" }).defaultModel).toBe("sol");
    expect(resolveCodeConfig(config, { AI_AGENT: "pi" }).defaultModel).toBe("openai/sol");
  });

  it("resumes a historical null profile on the built-ins of a coding harness only", () => {
    const config = loadConfig(
      makeHome({ code: { fallbackProfile: "global", profiles: PROFILES } }),
      "alignfirst",
    );
    const historical = { recorded: null };
    expect(resolveCodeConfig(config, { AI_AGENT: "pi" }, historical)).toMatchObject({
      profile: null,
      harness: "pi",
    });
    for (const env of [{}, { OPENCLAW_SHELL: "exec" }, { CLAUDECODE: "1", AI_AGENT: "pi" }])
      expect(() => resolveCodeConfig(config, env, historical)).toThrow(Error);
    expect(resolveCodeConfig(config, {}, { ...historical, explicit: "explicit" }).profile).toBe(
      "explicit",
    );
  });

  it("never falls through a named selection error", () => {
    const config = loadConfig(
      makeHome({ code: { fallbackProfile: "global", profiles: PROFILES } }),
      "alignfirst",
    );
    for (const selection of [
      { explicit: "missing" },
      { project: { profile: "missing" } },
      { recorded: "missing" },
      { explicit: " " },
    ]) {
      expect(() => resolveCodeConfig(config, { CLAUDECODE: "1" }, selection)).toThrow(Error);
    }
    expect(
      resolveCodeConfig(config, {}, { explicit: "explicit", recorded: "deleted" }).profile,
    ).toBe("explicit");
  });

  it("uses own properties for arbitrary profile and alias names", () => {
    const home = makeHome(
      JSON.parse(
        '{"code":{"fallbackProfile":"__proto__","profiles":{"__proto__":{"harness":"pi","modelAliases":{"constructor":"openai/sol"}}}}}',
      ),
    );
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), {}).profile).toBe("__proto__");
    writeConfig(home, { code: { fallbackProfile: "constructor", profiles: {} } });
    expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), {})).toThrow(Error);
  });

  it("validates defaults with the same accepted-name policy, without alias recursion", () => {
    const home = makeHome(
      profileConfig({ harness: "codex", defaultModel: "fast", modelAliases: { fast: "sol" } }),
    );
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), {}).defaultModel).toBe("fast");
    writeConfig(
      home,
      profileConfig({
        harness: "codex",
        defaultModel: "sol",
        models: ["fast"],
        modelAliases: { fast: "sol" },
      }),
    );
    expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), {})).toThrow(Error);
    writeConfig(
      home,
      profileConfig({ harness: "pi", defaultModel: " provider/model:high ", models: [] }),
    );
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), {}).defaultModel).toBe(
      " provider/model:high ",
    );
  });

  it.each([{}, { disabled: true }])(
    "rejects a defaultEffort outside the harness's built-in levels %j",
    (extra) => {
      const home = makeHome(
        profileConfig({ harness: "claude", defaultEffort: "minimal", ...extra }),
      );
      expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
    },
  );

  it("checks defaultEffort against the profile's own efforts when nonempty", () => {
    const home = makeHome(
      profileConfig({ harness: "claude", defaultEffort: "deep", efforts: ["quick", "deep"] }),
    );
    expect(loadConfig(home, "alignfirst").code.profiles?.test).toMatchObject({
      defaultEffort: "deep",
    });
    writeConfig(
      home,
      profileConfig({ harness: "claude", defaultEffort: "high", efforts: ["deep"] }),
    );
    expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR", ".claude"],
    ["codex", "CODEX_HOME", ".codex"],
    ["pi", "PI_CODING_AGENT_DIR", ".pi/agent"],
  ] as const)(
    "preserves omitted/null/string %s directory semantics immutably",
    (agent, variable, directory) => {
      const home = makeHome();
      const caller = Object.freeze({
        HOME: home,
        PATH: "/fixture/bin",
        ANTHROPIC_API_KEY: "private-key",
        CLAUDE_CONFIG_DIR: "inherited-claude",
        CODEX_HOME: "inherited-codex",
        PI_CODING_AGENT_DIR: "inherited-pi",
        TOKEN: "private-token",
        CLAUDE_CODE_SESSION_ID: "parent",
      });
      for (const configDir of [undefined, null, `~/${directory}`]) {
        writeConfig(
          home,
          profileConfig({ harness: agent, configDir, unset: ["TOKEN"], env: { KEEP: "yes" } }),
        );
        const path = join(home, ".alignfirst/aligndev.settings.json");
        const bytes = readFileSync(path);
        const config = loadConfig(home, "alignfirst");
        const stored = config.code.profiles?.test;
        if (stored?.harness === "openclaw") throw new Error("expected a coding-agent profile");
        Object.freeze(stored?.unset);
        Object.freeze(stored?.env);
        Object.freeze(stored);
        const before = JSON.stringify(config);
        const code = resolveCodeConfig(config, caller);
        const resolved = typeof configDir === "string" ? join(home, directory) : configDir;
        expect(code.configDir).toBe(resolved);
        expect(code.childEnv[variable]).toBe(
          resolved === null ? undefined : (resolved ?? caller[variable]),
        );
        if (configDir === null) expect(Object.hasOwn(code.childEnv, variable)).toBe(false);
        const description = describeNativeStorage(code);
        if (typeof resolved === "string") expect(description).toContain(resolved);
        expect(description).not.toContain(caller[variable]);
        expect(description).not.toContain("private-key");
        for (const other of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"] as const) {
          if (other !== variable) expect(code.childEnv[other]).toBe(caller[other]);
        }
        expect(code.childEnv).toMatchObject({
          HOME: home,
          PATH: caller.PATH,
          ANTHROPIC_API_KEY: caller.ANTHROPIC_API_KEY,
          KEEP: "yes",
        });
        expect(code.childEnv.TOKEN).toBeUndefined();
        expect(code.childEnv.CLAUDE_CODE_SESSION_ID).toBeUndefined();
        expect(code.unset).toEqual(["TOKEN"]);
        expect(caller[variable]).toBe(`inherited-${agent}`);
        expect(JSON.stringify(config)).toBe(before);
        expect(readFileSync(path)).toEqual(bytes);
      }
    },
  );

  it("finalizes the child environment once without mutating caller or merging profiles", () => {
    const home = makeHome({
      code: {
        profile: "global",
        profiles: {
          global: { harness: "codex", env: { OTHER: "no" }, skipPermissions: true },
          selected: {
            harness: "claude",
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
    const config = loadConfig(home, "alignfirst");
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
  it.each([false, true])("shares the assistant's profile across commands: %s", async (multiple) => {
    const home = makeHome({
      code: {
        profiles: {
          inferred: {
            harness: "claude",
            default: multiple,
            configDir: "~/native",
            defaultModel: "opus",
          },
          ...(multiple ? { other: { harness: "claude" } } : {}),
        },
      },
    });
    for (const args of [
      ["code", "--help"],
      ["guide", "code"],
      ["code", "quota"],
    ]) {
      let calls = 0;
      const env = { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: join(home, "native") };
      const result = await run(home, args, env, async (source, options) => {
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
  });

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
    expect(() => requireProjectsRoot(loadConfig(home, "alignfirst"))).toThrow();
  });

  it.each([["guide", "project"], ["guide"], ["code", "status", "--help"]])(
    "rejects --profile on unrelated commands %j",
    async (...args) => {
      const home = makeHome({
        projectsRoot: "~/projects",
        code: { fallbackProfile: "x", profiles: { x: { harness: "pi" } } },
      });
      mkdirSync(join(home, "projects"));
      const env = { ALIGNDEV_ASSISTANT_HARNESS: "openclaw" };
      const baseline = await run(home, args, env);
      expect(baseline.code, baseline.stderr).toBe(0);
      const result = await run(home, [...args, "--profile", "x"], env);
      expect(result.code).toBe(1);
    },
  );

  it("spares top-level help/version and status but rejects corrupt settings elsewhere", async () => {
    const home = makeHome({});
    writeFileSync(join(home, ".alignfirst/aligndev.settings.json"), "bad json");
    for (const args of [["--help"], ["--version"], ["code", "status", "--help"]]) {
      expect((await run(home, args)).code).toBe(0);
    }
    for (const args of [
      ["code", "--help"],
      ["code", "quota"],
      ["code", "new", "-m", "go"],
      ["guide"],
      ["project", "list"],
    ]) {
      expect((await run(home, args)).code).toBe(1);
    }
  });

  it("resolves the assistant's harness only for guide and profile-selecting code commands", async () => {
    const home = makeHome({ code: { fallbackProfile: "x", profiles: { x: { harness: "pi" } } } });
    const env = { ALIGNDEV_ASSISTANT_HARNESS: "unknown" };
    for (const args of [
      ["--help"],
      ["--version"],
      ["code", "status", "--help"],
      ["project", "--help"],
    ])
      expect((await run(home, args, env)).code).toBe(0);
    for (const args of [["code", "--help"], ["code", "quota"], ["guide"], ["guide", "code"]])
      expect((await run(home, args, env)).code).toBe(1);
  });
});
