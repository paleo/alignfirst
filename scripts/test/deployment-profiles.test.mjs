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
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveCodeConfig } from "../../packages/aligndev/dist/config.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const template = join(
  repository,
  "skills/alignfirst-setup-guide/assets/aligndev-openclaw-template",
);
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
  TEAM_NAME: "Fixture team",
  TEAM_MEMBERS: "- Example: developer",
  PORT_RANGE_FIRST: "28000",
  PORT_RANGE_LAST: "28599",
  PLANS_REPOSITORY_URL: "ssh://git@example.invalid/plans",
  PLANS_CLONE_NAME: "plans",
  PLANS_CLONE_NOTE: "",
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

for (const overlay of ["claude-code", "codex"]) {
  for (const surface of ["slack", "discord"]) {
    test(`${overlay}/${surface}: render options, syntax, modes and real profile validation`, () => {
      for (const gateway of [false, true]) {
        for (const plans of [false, true]) {
          withFixture(overlay, surface, { gateway, plans }, (fixture) => {
            for (const file of filesIn(fixture.rendered)) {
              const text = readFileSync(file, "utf8");
              assert(
                !/\{\{[A-Z][A-Z0-9_]*\}\}|TEAM_PLANS_SECTION|DEV_SERVER_GATEWAY_SECTION/u.test(
                  text,
                ),
                file,
              );
              if (file.endsWith(".json")) JSON.parse(text);
              if (text.startsWith("#!/usr/bin/env bash") || /\.(sh|bash)$/u.test(file)) {
                run(fixture, "bash", ["-n", file]);
              }
              if (file.endsWith(".mjs")) run(fixture, process.execPath, ["--check", file]);
            }
            for (const source of filesIn(join(template, "base"))) {
              if ((statSync(source).mode & 0o111) !== 0) {
                assert.equal(
                  statSync(join(fixture.rendered, source.slice(join(template, "base").length)))
                    .mode & 0o111,
                  statSync(source).mode & 0o111,
                );
              }
            }
            installSettings(fixture);
            const loaded = loadConfig(fixture.home);
            const effective = resolveCodeConfig(
              loaded,
              {
                HOME: fixture.home,
                CODEX_HOME: "/unintended-account",
                CLAUDE_CONFIG_DIR: "/unintended-account",
                ANTHROPIC_API_KEY: "fake",
                OPENAI_API_KEY: "fake",
                CODEX_API_KEY: "fake",
              },
              {},
            );
            assert.equal(effective.agent, fixture.agent);
            assert.equal(effective.profile, `service-${fixture.agent}`);
            assert.equal(effective.skipPermissions, true);
            const variable = fixture.agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
            assert.equal(effective.childEnv[variable], fixture.nativeDir);
            for (const name of fixture.settings.code.profiles[effective.profile].unset) {
              assert.equal(effective.childEnv[name], undefined);
            }
            assert.equal(effective.defaultModel, undefined, "Keep the native model default");
            assert.equal(existsSync(join(fixture.rendered, "infra/gateway")), gateway);
            assert.equal(existsSync(join(template, "variants/coding-agents/pi")), false);
          });
        }
      }
    });

    test(`${overlay}/${surface}: seed instructions are idempotent and every profile is explicit`, () => {
      withFixture(overlay, surface, {}, (fixture) => {
        const selected = fixture.settings.code.profile;
        fixture.settings.code.profiles["second profile"] = {
          ...fixture.settings.code.profiles[selected],
          defaultModel: fixture.agent === "codex" ? "sol" : "opus",
        };
        saveSettings(fixture);
        mkdirSync(fixture.nativeDir, { recursive: true });
        writeFileSync(fixture.instructions, "Operator text\n");
        const source = join(fixture.infra, "seed.sh");
        const seedFunctions = join(fixture.root, "seed-functions.sh");
        writeFileSync(seedFunctions, readFileSync(source, "utf8").replace(/main "\$@"\s*$/u, ""));
        // Source only fixture copies. No OpenClaw, privileged or authentication command is run.
        const script = `
          set -euo pipefail
          source "$1"
          DIR="$2"
          load_modules
          load_deployment_profiles
          configure_coding_agent
          install_aligndev_config
          configure_coding_agent
        `;
        const bin = join(fixture.root, "bin");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "aligndev"),
          `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$*" >> "$HOME/guide-calls"\nexec ${quote(process.execPath)} ${quote(join(repository, "packages/aligndev/bin/aligndev.mjs"))} "$@"\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(bin, "alignfirst"),
          `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(join(repository, "packages/alignfirst/bin/alignfirst.mjs"))} "$@"\n`,
          { mode: 0o755 },
        );
        const env = { ...fixture.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
        run(fixture, "git", ["init", "--quiet"]);
        const companions = join(fixture.home, ".alignfirst/companions");
        mkdirSync(companions, { recursive: true });
        writeFileSync(
          join(companions, "registry.json"),
          JSON.stringify({
            projects: { [fixture.home]: { aligndev: { profile: "missing-project-profile" } } },
          }),
        );
        run(fixture, "bash", ["-c", script, "fixture", seedFunctions, fixture.infra], env);
        const first = readFileSync(fixture.instructions, "utf8");
        const mtime = statSync(fixture.instructions).mtimeMs;
        run(fixture, "bash", ["-c", script, "fixture", seedFunctions, fixture.infra], env);
        assert.equal(readFileSync(fixture.instructions, "utf8"), first);
        assert.equal(statSync(fixture.instructions).mtimeMs, mtime);
        assert(first.startsWith("Operator text\n"));
        assert.equal(first.match(/<!-- alignfirst-dev-kit:start -->/gu).length, 1);
        assert.deepEqual(
          readFileSync(join(fixture.home, "guide-calls"), "utf8").trim().split("\n"),
          [
            `guide code --profile ${selected}`,
            "guide code --profile second profile",
            `guide code --profile ${selected}`,
            "guide code --profile second profile",
          ],
        );
        const inventory = readInventory(fixture);
        assert.equal(inventory.profiles.length, 2);
        assert.equal(inventory.instructionFile, fixture.instructions);
        assert.equal(inventory.skillsDir, join(fixture.nativeDir, "skills"));
        const redirected = spawnSync(
          process.execPath,
          [join(repository, "packages/aligndev/bin/aligndev.mjs"), "guide", "code"],
          { ...options(fixture), env },
        );
        assert.notEqual(
          redirected.status,
          0,
          "The explicit seed override bypasses a real project selection",
        );
        assert(redirected.stderr.includes("missing-project-profile"));
      });
    });
  }
}

test("inventory checks every selectable profile and refuses unsupported stores before maintenance", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    const original = structuredClone(fixture.settings);
    for (const configDir of ["~/.codex", fixture.nativeDir, "../.codex"]) {
      fixture.settings.code.profiles["service-codex"].configDir = configDir;
      saveSettings(fixture);
      assert.equal(readInventory(fixture).configDir, fixture.nativeDir);
    }
    const invalidProfiles = [
      { agent: "pi", configDir: "~/.pi/agent" },
      { agent: "claude", configDir: "~/.claude" },
      { agent: "codex", configDir: "~/.codex-work" },
      { agent: "codex", configDir: "../../escape" },
      { agent: "codex" },
      { agent: "codex", configDir: "~/.codex", env: { CODEX_HOME: "/elsewhere" } },
      { agent: "codex", configDir: "~/.codex", unset: ["CODEX_HOME"] },
      { agent: "codex", configDir: "~/.codex", quota: { source: "claude" } },
    ];
    for (const profile of invalidProfiles) {
      fixture.settings = structuredClone(original);
      fixture.settings.code.profiles.unselected = profile;
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
    for (const code of [
      { agent: "codex" },
      { profiles: original.code.profiles, profile: "missing" },
      { ...original.code, defaultProfiles: { codex: "missing" } },
      { profile: "pi", profiles: { pi: { agent: "pi", configDir: "~/.pi/agent" } } },
    ]) {
      fixture.settings = { ...original, code };
      saveSettings(fixture);
      assertInventoryRejected(fixture);
    }
    fixture.settings = original;
    saveSettings(fixture);
    symlinkSync(fixture.root, fixture.nativeDir);
    assertInventoryRejected(fixture);
    rmSync(fixture.nativeDir);
    mkdirSync(fixture.nativeDir);
    symlinkSync(join(fixture.root, "outside"), fixture.instructions);
    assertInventoryRejected(fixture);
    rmSync(fixture.instructions);
    symlinkSync(join(fixture.root, "outside"), join(fixture.nativeDir, "skills"));
    assertInventoryRejected(fixture);
  });
});

test("seed rejects a mismatched overlay before writing managed instructions or settings", () => {
  withFixture("codex", "slack", {}, (fixture) => {
    fixture.settings.code = {
      profile: "wrong-overlay",
      profiles: { "wrong-overlay": { agent: "claude", configDir: "~/.claude" } },
    };
    saveSettings(fixture);
    const functions = join(fixture.root, "seed-functions.sh");
    writeFileSync(
      functions,
      readFileSync(join(fixture.infra, "seed.sh"), "utf8").replace(/main "\$@"\s*$/u, ""),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; DIR="$2"; load_modules; load_deployment_profiles; configure_coding_agent; install_aligndev_config',
        "fixture",
        functions,
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

test("maintenance resolves profile inventory without invoking containment or privileged operations", () => {
  for (const overlay of ["claude-code", "codex"]) {
    withFixture(overlay, "discord", {}, (fixture) => {
      const wrapper = join(fixture.infra, "bin/assistant-maintenance.sh");
      const script = readFileSync(wrapper, "utf8")
        .replace(/main "\$@"\s*$/u, "")
        .replace("SERVICE_HOME=/home/fixture", `SERVICE_HOME=${quote(fixture.home)}`)
        .replace(
          "ADMIN_REPOSITORY=/home/operator/admin",
          `ADMIN_REPOSITORY=${quote(fixture.rendered)}`,
        )
        .replace(
          '/usr/bin/node "$ADMIN_REPOSITORY',
          `${quote(process.execPath)} "$ADMIN_REPOSITORY`,
        );
      const copy = join(fixture.root, "maintenance-functions.sh");
      writeFileSync(copy, script);
      const output = run(fixture, "bash", [
        "-c",
        'source "$1"; resolve_paths; printf "%s\\n" "$CODING_AGENT" "$INSTRUCTION_FILE" "$AGENT_SKILLS_DIR"',
        "fixture",
        copy,
      ]);
      assert.equal(
        output.trim(),
        [fixture.agent, fixture.instructions, join(fixture.nativeDir, "skills")].join("\n"),
      );
      fixture.settings.code.profiles.hidden = { agent: "pi", configDir: "~/.pi/agent" };
      saveSettings(fixture);
      const failed = spawnSync(
        "bash",
        ["-c", 'source "$1"; resolve_paths; echo SHOULD_NOT_RUN', "fixture", copy],
        options(fixture),
      );
      assert.notEqual(failed.status, 0);
      assert(!failed.stdout.includes("SHOULD_NOT_RUN"));
    });
  }
});

function withFixture(overlay, surface, choices, callback) {
  const root = mkdtempSync(join(tmpdir(), "side25-b8-profiles-"));
  const home = join(root, "home");
  const rendered = join(root, "admin");
  const agent = overlay === "codex" ? "codex" : "claude";
  const nativeDir = join(home, agent === "codex" ? ".codex" : ".claude");
  const infra = join(rendered, "infra/openclaw");
  const fixture = {
    root,
    home,
    rendered,
    agent,
    nativeDir,
    infra,
    instructions: join(nativeDir, agent === "codex" ? "AGENTS.md" : "CLAUDE.md"),
    settingsFile: join(infra, "aligndev.settings.json"),
    deployedSettings: join(home, ".alignfirst/aligndev.settings.json"),
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: root,
      USER: "fixture",
      LOGNAME: "fixture",
    },
  };
  try {
    mkdirSync(home);
    cpSync(join(template, "base"), rendered, { recursive: true });
    cpSync(join(template, "variants/surfaces", surface), rendered, { recursive: true });
    cpSync(join(template, "variants/coding-agents", overlay), rendered, { recursive: true });
    if (choices.gateway)
      cpSync(join(template, "variants/options/dev-server-gateway"), rendered, { recursive: true });
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
        assert(Object.hasOwn(tokens, name), `Missing token ${name}`);
        return tokens[name];
      });
      writeFileSync(file, text);
    }
    fixture.settings = JSON.parse(readFileSync(fixture.settingsFile, "utf8"));
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

function assertInventoryRejected(fixture) {
  const result = spawnSync(process.execPath, inventoryArgs(fixture), options(fixture));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
}

function run(fixture, command, args, env = fixture.env) {
  return execFileSync(command, args, { ...options(fixture), env });
}

function options(fixture) {
  return {
    cwd: fixture.home,
    env: fixture.env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
