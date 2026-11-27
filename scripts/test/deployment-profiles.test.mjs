import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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
import { fileURLToPath } from "node:url";
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

for (const overlay of Object.keys(agents)) {
  for (const surface of ["slack", "discord"]) {
    test(`${overlay}/${surface}: gateway × work-files rendering, syntax, dotfiles and modes`, () => {
      for (const gateway of [false, true]) {
        for (const plans of [false, true]) {
          withFixture(overlay, surface, { gateway, plans }, (fixture) => {
            auditRendered(fixture);
            installSettings(fixture);
            validateProfiles(fixture);
            assert.equal(existsSync(join(fixture.rendered, "infra/gateway")), gateway);
            const report = JSON.parse(
              run(fixture, process.execPath, [
                join(repository, "packages/alignfirst/bin/alignfirst.mjs"),
                "config",
                "--json",
              ]),
            );
            const config = report.config;
            assert.equal(
              report.locations.alignfirst.path,
              join(fixture.rendered, "alignfirst.jsonc"),
            );
            assert.equal(report.workspace.schemaVersion, 1);
            assert.equal(report.workspace.hasDevServer, false);
            assert.equal(config.schemaVersion, 1);
            assert.equal(config.conventions.git.defaultBranch, "main");
            assert.equal(config.assistantInstructionsFile, undefined);
            assert.equal(
              report.locations.assistantInstructionsFile.path,
              join(fixture.rendered, "ASSISTANTS.md"),
            );
            assert.equal(report.locations.assistantInstructionsFile.exists, true);
            assert.equal(report.workspace.location.path, report.locations.alignfirst.path);
            assert.equal(
              report.workspace.registryDir,
              join(fixture.rendered, ".local-wt/workspace-registry"),
            );
            assert.equal(existsSync(join(fixture.rendered, ".local-wt")), false);
            assert.equal(config.plans?.repositoryFolder, plans ? "admin" : undefined);
            assert(existsSync(join(fixture.infra, ".env.example")), "Include overlay dotfiles");
          });
        }
      }
    });

    test(`${overlay}/${surface}: default/custom seed idempotence and explicit all-profile CLI validation`, () => {
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
          const registry = join(fixture.home, ".alignfirst/companions");
          mkdirSync(registry, { recursive: true });
          writeFileSync(
            join(registry, "registry.json"),
            JSON.stringify({
              projects: {
                [fixture.rendered]: { aligndev: { profile: "missing-project-profile" } },
              },
            }),
          );
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
          const redirected = spawnSync(
            process.execPath,
            [join(repository, "packages/aligndev/bin/aligndev.mjs"), "guide", "code"],
            cliOptions(fixture),
          );
          assert.notEqual(redirected.status, 0);
          assert(redirected.stderr.includes("missing-project-profile"));
        });
      }
    });
  }
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
      if (overlay === "pi") profile.quota = { source: "codex", configDir: null };
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
      };
      const loaded = loadConfig(fixture.home);
      const reset = resolveCodeConfig(loaded, caller, { explicit: selected });
      const explicit = resolveCodeConfig(loaded, caller, { explicit: "explicit" });
      assert.equal(reset.configDir, null);
      assert.equal(reset.childEnv[definition.variable], undefined);
      assert.equal(explicit.configDir, fixture.nativeDir);
      assert.equal(explicit.childEnv[definition.variable], fixture.nativeDir);
      if (overlay === "pi") {
        assert.equal(
          inventory.stores.find((item) => item.harness === "codex").configDir,
          join(fixture.home, ".codex"),
        );
        const quota = resolveQuotaConfig(reset, caller);
        assert.equal(quota.source, "codex");
        assert.equal(quota.env.CODEX_HOME, undefined);
      }
      assert.equal(caller[definition.variable], "/inherited-wrong-account");
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    });
  }
});

test("native-default Pi rendering accepts typed custom directory and independent null quota", () => {
  const quota = { source: "claude", configDir: null };
  withFixture("pi", "slack", { custom: true, quota }, (fixture) => {
    const selected = selectedProfile(fixture.settings);
    assert.deepEqual(fixture.settings.code.profiles[selected].quota, quota);
    installSettings(fixture);
    const inventory = readInventory(fixture);
    assert.equal(inventory.configDir, fixture.nativeDir);
    assert.equal(
      inventory.stores.find((store) => store.harness === "claude").configDir,
      join(fixture.home, ".claude"),
    );
    const code = resolveCodeConfig(loadConfig(fixture.home), fixture.env, { explicit: selected });
    assert.equal(code.childEnv.PI_CODING_AGENT_DIR, fixture.nativeDir);
    assert.equal(
      resolveQuotaConfig(code, { CLAUDE_CONFIG_DIR: "/inherited" }).env.CLAUDE_CONFIG_DIR,
      undefined,
    );
  });
});

test("native-default inventory retains null-sensitive safety boundaries", () => {
  withFixture("codex", "discord", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    for (const invalid of [
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
    ]) {
      fixture.settings = structuredClone(original);
      Object.assign(fixture.settings.code.profiles[selectedProfile(fixture.settings)], invalid);
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
    fixture.settings = structuredClone(original);
    fixture.settings.projectsRoot = null;
    saveSettings(fixture);
    assertInventoryRejected(fixture);
    fixture.settings = structuredClone(original);
    fixture.settings.code.profiles.overlap = { harness: "pi", configDir: "~/.codex/nested" };
    saveSettings(fixture);
    assertInventoryRejected(fixture);
    fixture.settings = structuredClone(original);
    saveSettings(fixture);
    symlinkSync(fixture.root, fixture.nativeDir);
    assertInventoryRejected(fixture);
  });
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
      models: ["openai/fixture-model"],
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
    const inventory = readInventory(fixture);
    assert.equal(inventory.stores.length, 4);
    const codex = inventory.stores.find((store) => store.harness === "codex");
    assert.equal(codex.configDir, fixture.nativeDir);
    assert.deepEqual(codex.profiles.sort(), [selected, "shared"].sort());
    assert.deepEqual(
      inventory.stores.map((store) => relative(fixture.home, store.configDir)).sort(),
      [".codex", "native/pi", "native/claude-quota", "native/claude-child"].sort(),
    );
    const paths = inventory.resources.map((resource) => resource.path);
    const pi = join(fixture.home, "native/pi");
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
    ]) {
      assert(paths.includes(join(pi, name)), `Missing managed Pi path ${name}`);
    }
    for (const name of ["auth.json", "auth.json.lock", "sessions", "cache"]) {
      assert(!paths.includes(join(pi, name)), `Native mutable state must stay writable: ${name}`);
    }
  });
});

test("inventory rejects unsafe unselected stores and native-directory conflicts", () => {
  withFixture("codex", "discord", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    for (const profile of [
      { harness: "unsupported", configDir: "~/native/other" },
      { harness: "codex" },
      { harness: "codex", configDir: "../../escape" },
      { harness: "pi", configDir: fixture.home },
      { harness: "pi", configDir: "~/projects/agent" },
      { harness: "pi", configDir: "~/.codex/nested" },
      { harness: "pi", configDir: "~/.codex" },
      { harness: "codex", configDir: "~/native/other", env: { CODEX_HOME: "/elsewhere" } },
      { harness: "pi", configDir: "~/native/pi", unset: ["PI_CODING_AGENT_DIR"] },
      { harness: "pi", configDir: "~/native/pi", env: { HOME: "/elsewhere" } },
      {
        harness: "pi",
        configDir: "~/native/pi",
        quota: { source: "none", configDir: "~/native/quota" },
      },
    ]) {
      fixture.settings = structuredClone(original);
      fixture.settings.code.profiles.unselected = profile;
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
  });
});

test("inventory requires one enabled openclaw profile naming an enabled coding profile", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const selected = selectedProfile(original);
    const assistant = Object.keys(original.code.profiles).find(
      (name) => original.code.profiles[name].harness === "openclaw",
    );
    for (const change of [
      (code) => delete code.profiles[assistant],
      (code) => {
        code.profiles[assistant].disabled = true;
      },
      (code) => {
        code.profiles.second = { ...code.profiles[assistant] };
      },
      (code) => {
        code.profiles[assistant].defaultAgentProfile = "missing";
      },
      (code) => {
        code.profiles[selected].disabled = true;
      },
      (code) => {
        code.profiles[assistant].defaultAgentProfile = assistant;
      },
      (code) => {
        code.fallbackProfile = "missing";
      },
    ]) {
      fixture.settings = structuredClone(original);
      change(fixture.settings.code);
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
  });
});

test("inventory reports a fallbackProfile reference without any profiles", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    fixture.settings.code = { fallbackProfile: "missing" };
    saveSettings(fixture);
    assert.match(assertInventoryRejected(fixture), /code\.fallbackProfile/u);
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

test("inventory accepts the Pi settings deployed before model declarations", () => {
  withFixture("pi", "slack", {}, (fixture) => {
    const selected = selectedProfile(fixture.settings);
    delete fixture.settings.code.profiles[selected].models;
    saveSettings(fixture);
    assert.deepEqual(readInventory(fixture).profiles, [selected]);
  });
});

test("inventory rejects a malformed Pi modelFamilies", () => {
  withFixture("pi", "slack", {}, (fixture) => {
    const selected = selectedProfile(fixture.settings);
    for (const modelFamilies of [{ glm: "zai" }, { gpt: " " }, ["gpt"]]) {
      fixture.settings.code.profiles[selected].modelFamilies = modelFamilies;
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
    fixture.settings.code.profiles[selected].modelFamilies = { gpt: "openai" };
    saveSettings(fixture);
    assert.deepEqual(readInventory(fixture).profiles, [selected]);
  });
});

test("inventory and real CLI reject duplicate invalid harnesses without leaking values or injecting lines", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    const selected = selectedProfile(original);
    for (const harness of [
      undefined,
      null,
      true,
      1,
      {},
      ["codex"],
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
      installSettings(fixture);
      const before = readFileSync(fixture.settingsFile);
      const deployedBefore = readFileSync(fixture.deployedSettings);
      for (const args of [
        inventoryArgs(fixture),
        [
          join(repository, "packages/aligndev/bin/aligndev.mjs"),
          "guide",
          "code",
          "--profile",
          selected,
        ],
      ]) {
        const result = spawnSync(process.execPath, args, cliOptions(fixture));
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert(!result.stderr.includes("private-agent-marker"));
        assert.equal(result.stderr.trim().split("\n").length, 1);
        for (const character of ["\r", "\u001b", "\u0085", "\u2028", "\u2029", "\u202e"])
          assert(!result.stderr.includes(character));
        assert.deepEqual(readFileSync(fixture.settingsFile), before);
        assert.deepEqual(readFileSync(fixture.deployedSettings), deployedBefore);
      }
    }
  });
});

test("inventory refuses native root, managed resource and ancestor symlinks", () => {
  for (const path of ["root", "instructions", "skills", "ancestor"]) {
    withFixture("codex", "slack", {}, (fixture) => {
      if (path === "root") symlinkSync(fixture.root, fixture.nativeDir);
      else if (path === "ancestor") {
        symlinkSync(fixture.root, join(fixture.home, "linked"));
        fixture.settings.code.profiles[selectedProfile(fixture.settings)].configDir =
          "~/linked/native";
        saveSettings(fixture);
      } else {
        mkdirSync(fixture.nativeDir);
        symlinkSync(
          join(fixture.root, "outside"),
          path === "skills" ? join(fixture.nativeDir, "skills") : fixture.instructions,
        );
      }
      assertInventoryRejected(fixture);
    });
  }
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

for (const deployed of [true, false]) {
  const state = deployed ? "the deployed settings" : "the settings absent";
  test(`seed leaves ${state} when the real CLI rejects the candidate`, () => {
    withFixture("pi", "slack", {}, (fixture) => {
      if (deployed) installSettings(fixture);
      const before = deployed ? readFileSync(fixture.deployedSettings, "utf8") : undefined;
      const selected = selectedProfile(fixture.settings);
      // The inventory accepts an undeclared default; only the CLI rejects it.
      fixture.settings.code.profiles[selected].models = ["fixture/another-model"];
      saveSettings(fixture);
      const result = spawnSync(
        "bash",
        [
          "-euc",
          'source "$1"; DIR="$2"; load_modules; load_deployment_profiles; install_aligndev_config',
          "fixture",
          seedFunctions(fixture),
          fixture.infra,
        ],
        options(fixture),
      );
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(fixture.home, "guide-calls"), "utf8"), `${selected}\n`);
      assert.deepEqual(
        readdirSync(dirname(fixture.deployedSettings)),
        deployed ? ["aligndev.settings.json"] : [],
      );
      if (deployed) assert.equal(readFileSync(fixture.deployedSettings, "utf8"), before);
    });
  });
}

test("inventory and real CLI ignore stale settings without leaking values or rewriting input", () => {
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
    installSettings(fixture);
    const before = readFileSync(fixture.settingsFile);
    const deployedBefore = readFileSync(fixture.deployedSettings);
    const retiredWarnings = [];
    for (const args of [
      inventoryArgs(fixture),
      [
        join(repository, "packages/aligndev/bin/aligndev.mjs"),
        "guide",
        "code",
        "--profile",
        selected,
      ],
    ]) {
      const result = spawnSync(process.execPath, args, cliOptions(fixture));
      assert.equal(result.status, 0, result.stderr);
      retiredWarnings.push(
        result.stderr
          .split("\n")
          .filter((line) =>
            /setting (platform|code\.profile|code\.profiles\[<entry>\]\.agent)\./u.test(line),
          )
          .sort(),
      );
      assert.match(result.stderr, /unknownRoot/);
      assert(result.stderr.includes("unknownCode"));
      assert(result.stderr.includes("unknownProfile"));
      assert(result.stderr.includes("unknownQuota"));
      for (const text of [
        "private-value",
        "retired-value",
        "sk-secret-profile-name",
        "\u001b",
        "\u0085",
        "\u202e",
      ])
        assert(!result.stderr.includes(text));
      if (args[0].endsWith("deployment-profiles.mjs"))
        assert.equal(JSON.parse(result.stdout).profile, selected);
      else assert(result.stdout.includes(selected));
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
      assert.deepEqual(readFileSync(fixture.deployedSettings), deployedBefore);
    }
    assert.equal(retiredWarnings[0].length, 3);
    assert.deepEqual(
      retiredWarnings[0],
      retiredWarnings[1],
      "Same retired-key warnings as the CLI",
    );
  });
});

test("inventory and real CLI sanitize malformed settings JSON and preserve input bytes", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    installSettings(fixture);
    for (const text of ['{"secret":"private-json-value" trailing}', "private-json-value"]) {
      writeFileSync(fixture.settingsFile, text);
      writeFileSync(fixture.deployedSettings, text);
      const before = readFileSync(fixture.settingsFile);
      const deployedBefore = readFileSync(fixture.deployedSettings);
      const diagnostic = assertInventoryRejected(fixture);
      assert(!diagnostic.includes("private-json-value"));
      const result = spawnSync(
        process.execPath,
        [join(repository, "packages/aligndev/bin/aligndev.mjs"), "code", "--help"],
        cliOptions(fixture),
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert(result.stderr.includes(fixture.deployedSettings));
      assert(!result.stderr.includes("private-json-value"));
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
      assert.deepEqual(readFileSync(fixture.deployedSettings), deployedBefore);
    }
  });
});

test("inventory and real CLI still reject malformed recognized fields alongside unknown keys", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    for (const invalid of [
      { default: "yes" },
      { skipPermissions: "yes" },
      { models: "sol" },
      { modelAliases: { custom: 3 } },
      { modelFamilies: { gpt: "openai" } },
      { efforts: "high" },
      { defaultEffort: " " },
      { env: { CUSTOM: 3 } },
      { unset: "CUSTOM" },
      { env: { CUSTOM: "value" }, unset: ["CUSTOM"] },
      { quota: { source: "bad", unknownQuota: true } },
      { quota: { source: "none", env: {}, unknownQuota: true } },
    ]) {
      fixture.settings = structuredClone(original);
      const selected = selectedProfile(fixture.settings);
      Object.assign(fixture.settings.code.profiles[selected], invalid, {
        unknownFixtureField: "private-value",
      });
      saveSettings(fixture);
      installSettings(fixture);
      const before = readFileSync(fixture.settingsFile);
      const diagnostic = assertInventoryRejected(fixture);
      assert(diagnostic.includes("unknownFixtureField"));
      assert(!diagnostic.includes("private-value"));
      const result = spawnSync(
        process.execPath,
        [
          join(repository, "packages/aligndev/bin/aligndev.mjs"),
          "guide",
          "code",
          "--profile",
          selected,
        ],
        cliOptions(fixture),
      );
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert(!result.stderr.includes("private-value"));
      assert.deepEqual(readFileSync(fixture.settingsFile), before);
    }
  });
});

function assertInventoryRejected(fixture) {
  const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  return result.stderr;
}

function auditRendered(fixture) {
  for (const file of filesIn(fixture.rendered)) {
    const text = readFileSync(file, "utf8");
    assert(
      !/\{\{[A-Z][A-Z0-9_]*\}\}|TEAM_PLANS_SECTION|DEV_SERVER_GATEWAY_SECTION/u.test(text),
      file,
    );
    if (file.endsWith(".json")) JSON.parse(text);
    if (text.startsWith("#!/usr/bin/env bash") || /\.(sh|bash)$/u.test(file))
      run(fixture, "bash", ["-n", file]);
    if (/\.(mjs|js)$/u.test(file)) run(fixture, process.execPath, ["--check", file]);
  }
  for (const sourceRoot of fixture.sources) {
    for (const source of filesIn(sourceRoot)) {
      const destination = join(fixture.rendered, relative(sourceRoot, source));
      assert(existsSync(destination), `Missing copied file ${source}`);
      assert.equal(statSync(destination).mode & 0o111, statSync(source).mode & 0o111, destination);
    }
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
