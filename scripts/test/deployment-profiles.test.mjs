import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import {
  loadConfig,
  resolveCodeConfig,
  resolveQuotaConfig,
} from "../../packages/aligndev/dist/config.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const template = join(
  repository,
  "skills/aligndev-openclaw-setup/assets/aligndev-openclaw-template",
);
const guard = fileURLToPath(new URL("./fixtures/deployment-deny-network.mjs", import.meta.url));
const tokens = {
  ADMIN_REPOSITORY_NAME: "admin",
  ADMIN_REPOSITORY_URL: "ssh://git@example.invalid/admin",
  SERVER_HOST: "fixture.invalid",
  SERVER_ADMIN_USER: "operator",
  SERVICE_USER: "fixture",
  ASSISTANT_NAME: "Fixture",
  TIME_ZONE: "UTC",
  GIT_HOSTS: "github.com",
  RUNTIME_PROVIDER: "fixture",
  RUNTIME_MODEL: "fixture-model",
  PI_PROVIDER: "openai",
  PI_MODEL: "fixture-model",
  PI_CONFIG_DIR_JSON: "null",
  PI_CONFIG_DIR_DISPLAY: "~/.pi/agent (native default)",
  PI_AUTH_METHOD: "OAuth",
  PI_QUOTA_JSON: '{"source":"none"}',
  TEAM_NAME: "Fixture team",
  TEAM_MEMBERS: "- Example: developer",
  PORT_RANGE_FIRST: "28000",
  PORT_RANGE_LAST: "28599",
  PLANS_REPOSITORY_URL: "ssh://git@example.invalid/plans",
  PLANS_CLONE_NAME: "plans",
  SLACK_OWNER_ID: "U123",
  SLACK_CHANNEL_ID: "C123",
  DISCORD_OWNER_ID: "123",
  DISCORD_GUILD_ID: "456",
  DISCORD_CHANNEL_ID: "789",
  DEV_DOMAIN: "dev.example.invalid",
  CADDY_DNS_MODULE: "dns.providers.fixture",
  CADDY_DNS_PROVIDER: "fixture",
  PORT_RANGE_REGEX: "28[0-5][0-9]{2}",
  DEV_DOMAIN_REGEX: "dev\\.example\\.invalid",
};
const agents = {
  "claude-code": {
    harness: "claude",
    directory: ".claude",
    variable: "CLAUDE_CONFIG_DIR",
    instructions: "CLAUDE.md",
  },
  codex: {
    harness: "codex",
    directory: ".codex",
    variable: "CODEX_HOME",
    instructions: "AGENTS.md",
  },
  pi: {
    harness: "pi",
    directory: ".pi/agent",
    variable: "PI_CODING_AGENT_DIR",
    instructions: "AGENTS.md",
  },
};

// Each row breaks one deployment rule of the rendered Codex settings or native tree.
const rejections = [
  ...[
    { configDir: undefined },
    { configDir: 1 },
    { configDir: "~/bad\u0000path" },
    { defaultModel: null },
    { env: { CODEX_HOME: "/elsewhere" } },
    { unset: ["CODEX_HOME"] },
    { env: { HOME: "/elsewhere" } },
    { unset: ["PI_CODING_AGENT_SESSION_DIR"] },
    { quota: { source: "claude" } },
    { quota: { source: "claude", configDir: null, unset: ["CLAUDE_CONFIG_DIR"] } },
    { quota: { source: "none", configDir: null } },
  ].map((change) => [
    `selected ${label(change)}`,
    ({ selected }) => Object.assign(selected, change),
  ]),
  ...[
    { default: "yes" },
    { skipPermissions: "yes" },
    { models: "sol" },
    { modelAliases: { custom: 3 } },
    { efforts: "high" },
    { defaultEffort: " " },
    { env: { CUSTOM: 3 } },
    { unset: "CUSTOM" },
    { env: { CUSTOM: "value" }, unset: ["CUSTOM"] },
    { quota: { source: "bad", unknownQuota: true } },
    { quota: { source: "none", env: {}, unknownQuota: true } },
  ].map((change) => [
    `malformed beside an unknown key ${label(change)}`,
    ({ selected }) => Object.assign(selected, change, { unknownFixtureField: "private-value" }),
  ]),
  ...[
    { harness: "unsupported", configDir: "~/native/other" },
    { harness: "codex" },
    { harness: "codex", configDir: "../../escape" },
    { harness: "pi", configDir: "~/projects/agent" },
    { harness: "pi", configDir: "~/.codex/nested" },
    { harness: "pi", configDir: "~/.codex" },
    { harness: "pi", configDir: " ~/native/pi " },
    { harness: "pi", configDir: "file:///native/pi" },
    { harness: "codex", configDir: "~/native/other", env: { CODEX_HOME: "/elsewhere" } },
    { harness: "pi", configDir: "~/native/pi", unset: ["PI_CODING_AGENT_DIR"] },
    { harness: "pi", configDir: "~/native/pi", env: { HOME: "/elsewhere" } },
    {
      harness: "pi",
      configDir: "~/native/pi",
      quota: { source: "none", configDir: "~/native/quota" },
    },
  ].map((profile) => [
    `unselected ${label(profile)}`,
    ({ code }) => {
      code.profiles.unselected = profile;
    },
  ]),
  [
    "unselected store at the service home",
    ({ fixture, code }) => {
      code.profiles.unselected = { harness: "pi", configDir: fixture.home };
    },
  ],
  [
    "null projectsRoot",
    ({ fixture }) => {
      fixture.settings.projectsRoot = null;
    },
  ],
  ["no openclaw profile", ({ code, assistant }) => delete code.profiles[assistant]],
  [
    "disabled openclaw profile",
    ({ code, assistant }) => {
      code.profiles[assistant].disabled = true;
    },
  ],
  [
    "two openclaw profiles",
    ({ code, assistant }) => {
      code.profiles.second = { ...code.profiles[assistant] };
    },
  ],
  [
    "missing defaultAgentProfile target",
    ({ code, assistant }) => {
      code.profiles[assistant].defaultAgentProfile = "missing";
    },
  ],
  [
    "disabled defaultAgentProfile target",
    ({ selected }) => {
      selected.disabled = true;
    },
  ],
  [
    "openclaw defaultAgentProfile target",
    ({ code, assistant }) => {
      code.profiles[assistant].defaultAgentProfile = assistant;
    },
  ],
  [
    "missing fallbackProfile",
    ({ code }) => {
      code.fallbackProfile = "missing";
    },
  ],
  [
    "fallbackProfile without profiles",
    ({ fixture }) => {
      fixture.settings.code = { fallbackProfile: "missing" };
    },
  ],
  ["symlinked native root", ({ fixture }) => symlinkSync(fixture.root, fixture.nativeDir)],
  [
    "symlinked instructions",
    ({ fixture }) => {
      mkdirSync(fixture.nativeDir);
      symlinkSync(join(fixture.root, "outside"), fixture.instructions);
    },
  ],
  [
    "symlinked managed skills",
    ({ fixture }) => {
      mkdirSync(fixture.nativeDir);
      symlinkSync(join(fixture.root, "outside"), join(fixture.nativeDir, "skills"));
    },
  ],
  [
    "symlinked native ancestor",
    ({ fixture, selected }) => {
      symlinkSync(fixture.root, join(fixture.home, "linked"));
      selected.configDir = "~/linked/native";
    },
  ],
  [
    "hard-linked native file",
    ({ fixture }) => {
      mkdirSync(fixture.nativeDir);
      writeFileSync(join(fixture.nativeDir, "config.toml"), "");
      linkSync(join(fixture.nativeDir, "config.toml"), join(fixture.nativeDir, "linked.toml"));
    },
  ],
  ["Pi resource glob", (context) => writePiSettings(context, { extensions: ["../*.js"] })],
  [
    "padded Pi extension declaration",
    (context) => writePiSettings(context, { extensions: ["  ../../operator-extension.mjs  "] }),
  ],
  [
    "file URL Pi extension declaration",
    (context) =>
      writePiSettings(context, {
        extensions: [pathToFileURL(join(context.fixture.home, "operator-extension.mjs")).href],
      }),
  ],
  [
    "Pi package manifest escaping its tree",
    (context) => {
      const pi = writePiSettings(context, {});
      mkdirSync(join(pi, "extensions"));
      writeFileSync(
        join(pi, "extensions/package.json"),
        JSON.stringify({ pi: { extensions: ["../../outside.js"] } }),
      );
    },
  ],
];

// Each distinct template file is syntax-checked once, by the first rendering that copies it.
const syntaxChecked = new Set();

for (const { overlay, surface, gateway, plans } of [
  { overlay: "claude-code", surface: "slack", gateway: true, plans: true },
  { overlay: "codex", surface: "discord", gateway: false, plans: false },
  { overlay: "pi", surface: "slack", gateway: false, plans: true },
]) {
  test(`${overlay}/${surface}: rendering, syntax and real-CLI validation`, () => {
    withFixture(overlay, surface, { gateway, plans }, (fixture) => {
      auditRendered(fixture);
      installSettings(fixture);
      validateProfiles(fixture);
      const report = JSON.parse(
        run(fixture, process.execPath, [
          join(repository, "packages/alignfirst/bin/alignfirst.mjs"),
          "config",
          "--json",
        ]),
      );
      assert.equal(report.config.plans?.repositoryFolder, plans ? "admin" : undefined);
    });
  });
}

for (const [overlay, surface] of [
  ["claude-code", "slack"],
  ["codex", "discord"],
  ["pi", "slack"],
]) {
  test(`${overlay}: default/custom seed idempotence and explicit all-profile CLI validation`, () => {
    for (const custom of [false, true]) {
      withFixture(overlay, surface, { custom }, (fixture) => {
        const selected = selectedProfile(fixture.settings);
        fixture.settings.code.profiles["second profile"] = {
          ...fixture.settings.code.profiles[selected],
          defaultModel:
            fixture.harness === "codex"
              ? "sol"
              : fixture.harness === "claude"
                ? "opus"
                : fixture.settings.code.profiles[selected].defaultModel,
        };
        saveSettings(fixture);
        mkdirSync(fixture.nativeDir, { recursive: true });
        writeFileSync(fixture.instructions, "Operator text\n");
        const userProfile = join(fixture.nativeDir, "agents/operator.md");
        mkdirSync(dirname(userProfile), { recursive: true });
        writeFileSync(userProfile, "Operator-owned subagent profile\n");
        const nativeSettings = join(fixture.nativeDir, "settings.json");
        writeFileSync(nativeSettings, '{"theme":"dark"}\n');
        const functions = seedFunctions(fixture);
        const script =
          'source "$1"; DIR="$2"; load_modules; load_deployment_profiles; configure_coding_agent; install_aligndev_config; configure_coding_agent';
        run(fixture, "git", ["init", "--quiet"]);
        const args = ["-euc", script, "fixture", functions, fixture.infra];
        run(fixture, "bash", args);
        const first = readFileSync(fixture.instructions, "utf8");
        const mtime = statSync(fixture.instructions).mtimeMs;
        run(fixture, "bash", args);
        assert.equal(readFileSync(fixture.instructions, "utf8"), first);
        assert.equal(statSync(fixture.instructions).mtimeMs, mtime);
        assert.equal(readFileSync(userProfile, "utf8"), "Operator-owned subagent profile\n");
        assert.equal(readFileSync(nativeSettings, "utf8"), '{"theme":"dark"}\n');
        assert(first.startsWith("Operator text\n"));
        assert.equal(first.match(/<!-- alignfirst-dev-kit:start -->/gu)?.length, 1);
        const calls = readFileSync(join(fixture.home, "guide-calls"), "utf8").trim().split("\n");
        assert.deepEqual(calls, [selected, "second profile", selected, "second profile"]);
        const inventory = readInventory(fixture);
        assert.equal(inventory.profiles.length, 2);
        assert.equal(inventory.instructionFile, fixture.instructions);
        assert.equal(inventory.configDir, fixture.nativeDir);
      });
    }
  });
}

test("native-default inventory keeps absolute paths and real resolver modes for null and explicit strings", () => {
  for (const [overlay, definition] of Object.entries(agents)) {
    withFixture(overlay, "slack", {}, (fixture) => {
      const selected = selectedProfile(fixture.settings);
      const profile = fixture.settings.code.profiles[selected];
      assert.equal(profile.configDir, null, "Rendered defaults pin native-default mode");
      fixture.settings.code.profiles.explicit = {
        ...profile,
        configDir: `~/${definition.directory}`,
      };
      if (overlay === "pi") {
        profile.quota = { source: "codex", configDir: null };
        fixture.settings.code.profiles.explicit.quota = { source: "claude", configDir: null };
      }
      saveSettings(fixture);
      installSettings(fixture);
      const before = readFileSync(fixture.settingsFile);
      const inventory = readInventory(fixture);
      assert.equal(inventory.configDir, fixture.nativeDir);
      const store = inventory.stores.find((item) => item.harness === definition.harness);
      assert.deepEqual(store.profiles, [selected, "explicit"]);
      for (const item of inventory.stores) {
        assert(item.configDir.startsWith(`${fixture.home}/`));
        assert.equal(typeof item.configDir, "string");
      }
      assert(inventory.resources.every((item) => item.path.startsWith(`${fixture.home}/`)));
      const caller = {
        ...fixture.env,
        [definition.variable]: "/inherited-wrong-account",
        CODEX_HOME: "/inherited-wrong-account",
        CLAUDE_CONFIG_DIR: "/inherited-wrong-account",
      };
      const loaded = loadConfig(fixture.home);
      const reset = resolveCodeConfig(loaded, caller, { explicit: selected });
      const explicit = resolveCodeConfig(loaded, caller, { explicit: "explicit" });
      assert.equal(reset.configDir, null);
      assert.equal(reset.childEnv[definition.variable], undefined);
      assert.equal(explicit.configDir, fixture.nativeDir);
      assert.equal(explicit.childEnv[definition.variable], fixture.nativeDir);
      if (overlay === "pi") {
        for (const [harness, quotaOwner, variable] of [
          ["codex", reset, "CODEX_HOME"],
          ["claude", explicit, "CLAUDE_CONFIG_DIR"],
        ]) {
          assert.equal(
            inventory.stores.find((item) => item.harness === harness).configDir,
            join(fixture.home, agents[harness === "claude" ? "claude-code" : harness].directory),
          );
          const quota = resolveQuotaConfig(quotaOwner, caller);
          assert.equal(quota.source, harness);
          assert.equal(quota.env[variable], undefined);
        }
      }
      assert.equal(caller[definition.variable], "/inherited-wrong-account");
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    });
  }
});

test("inventory deduplicates shared stores and includes custom, mixed-agent and independent quota stores", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const selected = selectedProfile(fixture.settings);
    fixture.settings.code.profiles.shared = {
      ...fixture.settings.code.profiles[selected],
      configDir: "../.codex",
    };
    fixture.settings.code.profiles.pi = {
      harness: "pi",
      configDir: "~/native/pi",
      defaultModel: "openai/fixture-model",
      quota: { source: "claude", configDir: "~/native/claude-quota" },
    };
    fixture.settings.code.profiles.other = {
      harness: "claude",
      configDir: "~/native/claude-child",
      quota: { source: "none" },
    };
    for (const name of [selected, "pi", "other"])
      fixture.settings.code.profiles[name].default = true;
    saveSettings(fixture);
    installSettings(fixture);
    validateProfiles(fixture);
    const assistant = Object.values(fixture.settings.code.profiles).find(
      (profile) => profile.harness === "openclaw",
    );
    assistant.defaultAgentProfile = "pi";
    saveSettings(fixture);
    const inventory = readInventory(fixture);
    const pi = join(fixture.home, "native/pi");
    assert.equal(inventory.harness, "pi");
    assert.equal(inventory.configDir, pi);
    assert.equal(inventory.stores.length, 4);
    const codex = inventory.stores.find((store) => store.harness === "codex");
    assert.equal(codex.configDir, fixture.nativeDir);
    assert.deepEqual(codex.profiles.sort(), [selected, "shared"].sort());
    assert.deepEqual(
      inventory.stores.map((store) => relative(fixture.home, store.configDir)).sort(),
      [".codex", "native/pi", "native/claude-quota", "native/claude-child"].sort(),
    );
    const paths = inventory.resources.map((resource) => resource.path);
    for (const name of [
      "AGENTS.override.md",
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "trust.json",
      "settings.json",
      "models.json",
      "mcp.json",
      "extensions",
      "skills",
      "prompts",
      "themes",
      "npm",
      "git",
      "agents",
      "bin",
    ]) {
      assert(paths.includes(join(pi, name)), `Missing managed Pi path ${name}`);
    }
    assert(paths.includes(join(fixture.home, "AGENTS.override.md")), "Home context sentinel");
    for (const name of ["auth.json", "auth.json.lock", "sessions", "cache"]) {
      assert(!paths.includes(join(pi, name)), `Native mutable state must stay writable: ${name}`);
    }
  });
});

test("inventory rejects unsafe settings and native trees", () => {
  withFixture("codex", "discord", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const apply = (change) => {
      rmSync(fixture.home, { recursive: true, force: true });
      mkdirSync(fixture.home);
      fixture.settings = structuredClone(original);
      const code = fixture.settings.code;
      change({
        fixture,
        code,
        selected: code.profiles[selectedProfile(original)],
        assistant: Object.keys(code.profiles).find(
          (name) => code.profiles[name].harness === "openclaw",
        ),
      });
      saveSettings(fixture);
    };
    apply((context) => writePiSettings(context, { extensions: ["../../operator-extension.mjs"] }));
    readInventory(fixture);
    for (const [label, change] of rejections) {
      apply(change);
      assertInventoryRejected(fixture, label);
    }
  });
});

test("inventory validates every flag and counts enabled defaults only", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const selected = selectedProfile(original);
    for (const value of [null, "true", 1, [], {}]) {
      fixture.settings = structuredClone(original);
      fixture.settings.code.profiles[selected].default = value;
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
    fixture.settings = structuredClone(original);
    fixture.settings.code.profiles[selected].default = true;
    fixture.settings.code.profiles.conflict = {
      ...fixture.settings.code.profiles[selected],
      configDir: "~/native/conflict",
    };
    saveSettings(fixture);
    assertInventoryRejected(fixture);
    fixture.settings.code.profiles.conflict.default = false;
    saveSettings(fixture);
    assert.equal(readInventory(fixture).profiles.length, 2);
    for (const map of [{}, null, { codex: selected }]) {
      fixture.settings = structuredClone(original);
      fixture.settings.code.defaultProfiles = map;
      fixture.settings.code.profiles[selected].default = true;
      saveSettings(fixture);
      const before = readFileSync(fixture.settingsFile);
      const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).profile, selected);
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    }
  });
});

test("inventory ignores disabled profiles but still validates their shape", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const selected = selectedProfile(original);
    fixture.settings.code.profiles[selected].default = true;
    fixture.settings.code.profiles.retired = {
      harness: "codex",
      disabled: true,
      default: true,
      configDir: "~/.codex/nested",
    };
    saveSettings(fixture);
    const inventory = readInventory(fixture);
    assert.deepEqual(inventory.profiles, [selected]);
    assert.deepEqual(
      inventory.stores.map((store) => store.profiles),
      [[selected]],
    );
    fixture.settings.code.profiles.retired.skipPermissions = "yes";
    saveSettings(fixture);
    assertInventoryRejected(fixture);
  });
});

test("inventory rejects duplicate invalid harnesses without leaking values or injecting lines", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const selected = selectedProfile(original);
    for (const harness of [
      "constructor",
      "private-agent-marker\n\r\u001b\u0085\u2028\u2029\u202e",
    ]) {
      fixture.settings = structuredClone(original);
      Object.assign(fixture.settings.code.profiles[selected], { harness, default: true });
      fixture.settings.code.profiles.conflict = {
        harness,
        default: true,
        configDir: "~/native/conflict",
      };
      saveSettings(fixture);
      const before = readFileSync(fixture.settingsFile);
      const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert(!result.stderr.includes("private-agent-marker"));
      assert.equal(result.stderr.trim().split("\n").length, 1);
      for (const character of ["\r", "\u001b", "\u0085", "\u2028", "\u2029", "\u202e"])
        assert(!result.stderr.includes(character));
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    }
  });
});

test("seed rejects a mismatched overlay before writing instructions or installed settings", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    fixture.settings.code = {
      profiles: {
        openclaw: { harness: "openclaw", defaultAgentProfile: "wrong-overlay" },
        "wrong-overlay": { harness: "claude", configDir: "~/.claude" },
      },
    };
    saveSettings(fixture);
    const result = spawnSync(
      "bash",
      [
        "-euc",
        'source "$1"; DIR="$2"; load_modules; load_deployment_profiles; configure_coding_agent; install_aligndev_config',
        "fixture",
        seedFunctions(fixture),
        fixture.infra,
      ],
      options(fixture),
    );
    assert.notEqual(result.status, 0);
    assert(!existsSync(fixture.deployedSettings));
    assert(!existsSync(fixture.instructions));
    assert(!existsSync(join(fixture.home, ".claude")));
  });
});

test("inventory ignores stale settings without leaking values or rewriting input", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const selected = selectedProfile(fixture.settings);
    fixture.settings.platform = "openclaw";
    fixture.settings.code.profile = selected;
    fixture.settings.unknownRoot = "private-value";
    fixture.settings.code.unknownCode = { nested: "private-value" };
    fixture.settings.code.agent = "retired-value";
    fixture.settings.code.defaultProfiles = { codex: "missing" };
    fixture.settings.code.profiles["sk-secret-profile-name"] = {
      harness: "pi",
      agent: "retired-value",
      configDir: "~/native/pi",
      unknownProfile: "private-value",
      env: { CUSTOM: "private-value" },
      modelAliases: { custom: "private-value" },
      quota: { source: "none", unknownQuota: "private-value" },
    };
    fixture.settings["bad\n\u001b\u0085\u202e.key"] = "private-value";
    saveSettings(fixture);
    const before = readFileSync(fixture.settingsFile);
    const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
    assert.equal(result.status, 0, result.stderr);
    for (const text of [
      "private-value",
      "retired-value",
      "sk-secret-profile-name",
      "\u001b",
      "\u0085",
      "\u202e",
    ])
      assert(!result.stderr.includes(text));
    assert.equal(JSON.parse(result.stdout).profile, selected);
    assert.deepEqual(readFileSync(fixture.settingsFile), before);
  });
});

test("inventory sanitizes malformed settings JSON and preserves input bytes", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    for (const text of ['{"secret":"private-json-value" trailing}', "private-json-value"]) {
      writeFileSync(fixture.settingsFile, text);
      const before = readFileSync(fixture.settingsFile);
      assert(!assertInventoryRejected(fixture).includes("private-json-value"));
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    }
  });
});

function assertInventoryRejected(fixture, label) {
  const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
  assert.notEqual(result.status, 0, label);
  assert.equal(result.stdout, "", label);
  return result.stderr;
}

function label(value) {
  return inspect(value, { breakLength: Number.POSITIVE_INFINITY });
}

// Adds a Pi profile with its native settings beside the rendered Codex profile.
function writePiSettings({ fixture, code }, settings) {
  const pi = join(fixture.home, "native/pi");
  code.profiles.pi = { harness: "pi", configDir: "~/native/pi" };
  mkdirSync(pi, { recursive: true });
  writeFileSync(join(pi, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(fixture.home, "operator-extension.mjs"), "export default function () {}\n");
  return pi;
}

function auditRendered(fixture) {
  for (const file of filesIn(fixture.rendered)) {
    const text = readFileSync(file, "utf8");
    assert(
      !/\{\{[A-Z][A-Z0-9_]*\}\}|TEAM_PLANS_SECTION|DEV_SERVER_GATEWAY_SECTION/u.test(text),
      file,
    );
    if (file.endsWith(".json")) JSON.parse(text);
    const path = relative(fixture.rendered, file);
    const source = fixture.sources.findLast((root) => existsSync(join(root, path)));
    if (syntaxChecked.has(join(source, path))) continue;
    syntaxChecked.add(join(source, path));
    if (text.startsWith("#!/usr/bin/env bash") || /\.(sh|bash)$/u.test(file))
      run(fixture, "bash", ["-n", file]);
    if (/\.(mjs|js)$/u.test(file)) run(fixture, process.execPath, ["--check", file]);
  }
}

function validateProfiles(fixture) {
  const selected = selectedProfile(fixture.settings);
  const loaded = loadConfig(fixture.home);
  const effective = resolveCodeConfig(
    loaded,
    {
      ...cliOptions(fixture).env,
      CODEX_HOME: "/unintended-account",
      CLAUDE_CONFIG_DIR: "/unintended-account",
      PI_CODING_AGENT_DIR: "/unintended-account",
      ANTHROPIC_API_KEY: "fixture-fake",
      OPENAI_API_KEY: "fixture-fake",
      CODEX_API_KEY: "fixture-fake",
    },
    { explicit: selected },
  );
  assert.equal(effective.harness, fixture.harness);
  assert.equal(effective.profile, selected);
  assert.equal(
    effective.childEnv[agents[fixture.overlay].variable],
    fixture.settings.code.profiles[selected].configDir === null ? undefined : fixture.nativeDir,
  );
  for (const name of fixture.settings.code.profiles[selected].unset ?? []) {
    assert.equal(effective.childEnv[name], undefined);
  }
  if (fixture.harness !== "pi") {
    assert.equal(effective.skipPermissions, true);
    assert.equal(effective.defaultModel, undefined, "Preserve existing native model defaults");
  } else {
    assert.notEqual(effective.defaultModel, undefined, "Pi model policy is explicit");
  }
  for (const name of codingProfiles(fixture.settings)) {
    const output = execFileSync(
      process.execPath,
      [join(repository, "packages/aligndev/bin/aligndev.mjs"), "guide", "code", "--profile", name],
      cliOptions(fixture),
    );
    assert(
      output.includes(name),
      "Validate settings through the real CLI, without launching an agent",
    );
    assert(!output.includes("fixture-fake"));
  }
}

function withFixture(overlay, surface, choices, callback) {
  const root = mkdtempSync(join(tmpdir(), "side25-b8-profiles-"));
  const home = join(root, "home");
  const rendered = join(root, "admin");
  const definition = agents[overlay];
  const nativeDir = join(home, choices.custom ? "native/custom agent" : definition.directory);
  const infra = join(rendered, "infra/openclaw");
  const bin = join(root, "bin");
  const fixture = {
    root,
    home,
    rendered,
    overlay,
    harness: definition.harness,
    nativeDir,
    infra,
    instructions: join(nativeDir, definition.instructions),
    settingsFile: join(infra, "aligndev.settings.json"),
    deployedSettings: join(home, ".alignfirst/aligndev.settings.json"),
    sources: [
      join(template, "base"),
      join(template, "variants/surfaces", surface),
      join(template, "variants/coding-agents", overlay),
    ],
    env: {
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: root,
      USER: "fixture",
      LOGNAME: "fixture",
      NODE_OPTIONS: `--import=${guard}`,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
  };
  try {
    mkdirSync(home);
    mkdirSync(bin);
    for (const command of [
      "sudo",
      "chown",
      "chattr",
      "systemctl",
      "loginctl",
      "podman",
      "docker",
      "openclaw",
      "pi",
      "claude",
      "codex",
      "npm",
      "curl",
      "wget",
    ]) {
      writeFileSync(
        join(bin, command),
        '#!/usr/bin/env bash\nprintf "Forbidden deployment fixture command: %s\\n" "$0" >&2\nexit 97\n',
        { mode: 0o755 },
      );
    }
    if (choices.gateway)
      fixture.sources.push(join(template, "variants/options/dev-server-gateway"));
    for (const source of fixture.sources) cpSync(source, rendered, { recursive: true });
    const values = {
      ...tokens,
      PI_CONFIG_DIR_JSON: choices.custom ? JSON.stringify(nativeDir) : "null",
      PI_CONFIG_DIR_DISPLAY: choices.custom ? nativeDir : tokens.PI_CONFIG_DIR_DISPLAY,
      PI_QUOTA_JSON: JSON.stringify(choices.quota ?? { source: "none" }),
    };
    for (const file of filesIn(rendered)) {
      let text = readFileSync(file, "utf8");
      for (const [marker, enabled] of [
        ["DEV_SERVER_GATEWAY_SECTION", choices.gateway],
        ["TEAM_PLANS_SECTION", choices.plans],
      ]) {
        let inside = false;
        text = text
          .split("\n")
          .filter((line) => {
            if (line.includes(marker)) {
              inside = !inside;
              return false;
            }
            return enabled || !inside;
          })
          .join("\n");
        assert.equal(inside, false, `Paired ${marker}: ${file}`);
      }
      text = text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/gu, (_, name) => {
        assert(Object.hasOwn(values, name), `Missing token ${name}`);
        return values[name];
      });
      writeFileSync(file, text);
    }
    fixture.settings = JSON.parse(readFileSync(fixture.settingsFile, "utf8"));
    if (overlay === "pi")
      assert.equal(
        fixture.settings.code.profiles[selectedProfile(fixture.settings)].configDir,
        choices.custom ? nativeDir : null,
        "Render a typed JSON directory selection before fixture adjustments",
      );
    for (const name of codingProfiles(fixture.settings)) {
      const profile = fixture.settings.code.profiles[name];
      if (choices.custom) profile.configDir = nativeDir;
      else if (typeof profile.configDir === "string")
        profile.configDir = profile.configDir.replace("/home/fixture/", `${home}/`);
    }
    saveSettings(fixture);
    writeFileSync(join(bin, "npx"), npxDouble(), { mode: 0o755 });
    writeFileSync(
      join(bin, "alignfirst"),
      `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(join(repository, "packages/alignfirst/bin/alignfirst.mjs"))} "$@"\n`,
      { mode: 0o755 },
    );
    callback(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function filesIn(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesIn(child) : [child];
  });
}

function installSettings(fixture) {
  mkdirSync(dirname(fixture.deployedSettings), { recursive: true });
  cpSync(fixture.settingsFile, fixture.deployedSettings);
}

function saveSettings(fixture) {
  writeFileSync(fixture.settingsFile, JSON.stringify(fixture.settings));
}

function seedFunctions(fixture) {
  const functions = join(fixture.root, "seed-functions.sh");
  writeFileSync(
    functions,
    readFileSync(join(fixture.infra, "seed.sh"), "utf8").replace(/main "\$@"\s*$/u, ""),
  );
  return functions;
}

function readInventory(fixture) {
  return JSON.parse(run(fixture, process.execPath, inventoryArgs(fixture)));
}

function inventoryArgs(fixture) {
  return [
    join(fixture.infra, "deployment-profiles.mjs"),
    fixture.settingsFile,
    fixture.home,
    fixture.deployedSettings,
  ];
}

function run(fixture, command, args) {
  return execFileSync(command, args, options(fixture));
}

function options(fixture) {
  return {
    cwd: fixture.rendered,
    env: fixture.env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  };
}

// A real-CLI call as the assistant, the way the seed and the runbooks make it.
function cliOptions(fixture) {
  return { ...options(fixture), env: { ...fixture.env, ALIGNDEV_ASSISTANT_HARNESS: "openclaw" } };
}

// The deployment default: the enabled openclaw profile's defaultAgentProfile.
function selectedProfile(settings) {
  return Object.values(settings.code.profiles).find(
    (profile) => profile.harness === "openclaw" && profile.disabled !== true,
  ).defaultAgentProfile;
}

function codingProfiles(settings) {
  return Object.entries(settings.code.profiles)
    .filter(([, profile]) => profile.harness !== "openclaw")
    .map(([name]) => name);
}

// Runs the checkout's CLIs for `npx -y aligndev|alignfirst` and records each seed validation.
function npxDouble() {
  const aligndev = join(repository, "packages/aligndev/bin/aligndev.mjs");
  const alignfirst = join(repository, "packages/alignfirst/bin/alignfirst.mjs");
  return `#!/usr/bin/env bash
set -eu
forbid() { printf 'Forbidden deployment fixture command: npx %s\\n' "$*" >&2; exit 97; }
[ "\${1:-}" = -y ] || forbid "$@"
case "\${2:-}" in
  aligndev)
    shift 2
    if [ "\${1:-} \${2:-}" = "guide code" ]; then
      if [ "\${ALIGNDEV_ASSISTANT_HARNESS:-}" != openclaw ]; then
        echo "npx double: the seed must set ALIGNDEV_ASSISTANT_HARNESS=openclaw" >&2
        exit 98
      fi
      printf '%s\\n' "\${4:-}" >> "$HOME/guide-calls"
    fi
    exec ${quote(process.execPath)} ${quote(aligndev)} "$@"
    ;;
  alignfirst)
    shift 2
    exec ${quote(process.execPath)} ${quote(alignfirst)} "$@"
    ;;
  *) forbid "$@" ;;
esac
`;
}

function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
