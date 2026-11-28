import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installStandIns,
  readJournal,
  replayState,
  standInEnv,
} from "./fixtures/deployment-standins.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const template = join(
  repository,
  "skills/aligndev-openclaw-setup/assets/aligndev-openclaw-template",
);
const networkGuard = fileURLToPath(
  new URL("fixtures/deployment-deny-network.mjs", import.meta.url),
);
const permissionGuard = fileURLToPath(
  new URL("fixtures/deployment-permission-guard.mjs", import.meta.url),
);
const agents = ["claude-code", "codex", "pi"];
const tokens = {
  SERVICE_USER: "fixture",
  SERVER_ADMIN_USER: "operator",
  ADMIN_REPOSITORY_NAME: "admin",
  PI_CONFIG_DIR_JSON: "null",
  PI_CONFIG_DIR_DISPLAY: "~/.pi/agent (native default)",
  PI_PROVIDER: "openai",
  PI_MODEL: "fixture-model",
  PI_AUTH_METHOD: "OAuth",
  PI_QUOTA_JSON: '{"source":"none"}',
  PORT_RANGE_FIRST: "28000",
  PORT_RANGE_LAST: "28599",
};
const standIns = [
  "sudo",
  ["install", "install.mjs"],
  "id",
  "rsync",
  "chown",
  "chmod",
  "chattr",
  "runuser",
  "openclaw",
  ["claude", "native-agent"],
  ["codex", "native-agent"],
  ["pi", "native-agent"],
  "mktemp",
  "date",
  "find",
  "cmp",
  "rm",
  "jq",
  "bash",
  "stat",
  "true",
  "false",
];

// Each source document is checked once: overlays replace or add whole documents.
for (const source of [
  "base",
  ...agents.map((agent) => `variants/coding-agents/${agent}`),
  "variants/surfaces/discord",
  "variants/surfaces/slack",
  "variants/options/dev-server-gateway",
]) {
  test(`${source}: every rendered runbook shell example parses`, () => {
    let count = 0;
    for (const path of files(join(template, source, "docs"))) {
      for (const block of shellBlocks(render(readFileSync(path, "utf8"), "claude-code"))) {
        const result = spawnSync("/bin/bash", ["-n"], { input: block, encoding: "utf8" });
        assert.equal(
          result.status,
          0,
          `${relative(template, path)} block ${count}: ${result.stderr}`,
        );
        ++count;
      }
    }
    assert(count > 0, "Expected at least one rendered shell example");
  });
}

test("rendered protected-helper install, backup and exact maintenance recovery", () => {
  fixture("claude-code", "slack", (f) => {
    f.install();
    f.prepare();
    const native = f.native;
    writeFileSync(join(native, "CLAUDE.md"), "reviewed instructions\n");
    writeFileSync(join(native, "auth.json"), '{"fixture":"not-a-credential"}\n');
    mkdirSync(join(native, "sessions"));
    writeFileSync(join(native, "sessions/conversation"), "private fixture transcript\n");
    f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
    const anchors = [f.home, native];
    for (const anchor of anchors) {
      assert.equal(f.state()[anchor].owner, "root");
      assert.equal(f.state()[anchor].mode, 0o1770);
    }
    f.run(f.block("operations/update-assistant.md", "seed/bin/backup.sh"));
    const backups = join(f.home, "backups/deployment");
    const stamp = readdirSync(backups)[0];
    for (const path of files(join(backups, stamp)))
      assert.equal(statSync(path).mode & 0o077, 0, path);
    writeFileSync(join(native, "sessions/post-backup"), "must disappear\n");
    writeFileSync(join(native, "auth.json"), "post-backup credential fixture\n");
    f.run(
      f
        .block("operations/recover-assistant.md", "deployment-policy.mjs recover")
        .replaceAll("fixture-backup", stamp),
    );
    assert(!existsSync(join(native, "sessions/post-backup")));
    assert.equal(
      readFileSync(join(native, "auth.json"), "utf8"),
      '{"fixture":"not-a-credential"}\n',
    );
    assert.equal(readFileSync(join(native, "CLAUDE.md"), "utf8"), "reviewed instructions\n");
    for (const anchor of anchors) {
      assert.equal(f.state()[anchor].owner, "root");
      assert.equal(statSync(anchor).mode & 0o7777, 0o1770, "Recovery must preserve sticky anchors");
    }
  });
});

test("native-default rendered Codex authentication removes login-shell routing and preserves explicit strings", () => {
  fixture("codex", "slack", (f) => {
    f.install();
    const block = f.block("installations/08-coding-agent.md", "codex login --device-auth");
    const interactive = block.replace(
      "sudo -i -u fixture\n",
      "sudo -H -u fixture bash -l <<'NATIVE_LOGIN'\n",
    );
    assert.notEqual(interactive, block, "Replace only the interactive account-shell entry");
    for (const selection of [null, "~/.codex", "../native/custom codex"]) {
      const settings = JSON.parse(readFileSync(f.deployed, "utf8"));
      settings.code.profiles[selectedProfile(settings)].configDir = selection;
      writeFileSync(f.deployed, JSON.stringify(settings));
      const start = f.natives().length;
      f.run(`${interactive}\nNATIVE_LOGIN`, 0, {
        CODEX_HOME: "/inherited-wrong-account",
        STANDIN_LOGIN_CODEX_HOME: "/login-shell-wrong-account",
      });
      const calls = f.natives().slice(start);
      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["login", "--device-auth"],
          ["login", "status"],
        ],
      );
      for (const call of calls) {
        assert.equal(
          call.configDir,
          selection === null
            ? undefined
            : selection === "~/.codex"
              ? f.native
              : join(f.home, "native/custom codex"),
          `${selection}`,
        );
        assert.equal(call.apiKeyPresent, false);
      }
    }
  });
});

test("install inventory crosses private account boundaries and fails closed without errexit", () => {
  for (const agent of agents) {
    fixture(agent, "slack", (f) => {
      const command = agent === "claude-code" ? "claude" : agent;
      const variable = {
        claude: "CLAUDE_CONFIG_DIR",
        codex: "CODEX_HOME",
        pi: "PI_CODING_AGENT_DIR",
      }[command];
      const settingsPath = join(f.admin, "infra/openclaw/aligndev.settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const profile = settings.code.profiles[selectedProfile(settings)];
      const guard = join(f.root, "private-home.mjs");
      writeFileSync(
        guard,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (process.env.STANDIN_ROLE === "service" &&
      String(path).startsWith(${JSON.stringify(f.admin)} + "/")) {
    throw Object.assign(new Error("EACCES: private admin repository"), { code: "EACCES" });
  }
  return read(path, ...args);
};
const lstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  if (process.env.STANDIN_ROLE === "operator" &&
      String(path).startsWith(process.env.STANDIN_HOME + "/")) {
    throw Object.assign(new Error("EACCES: private service home"), { code: "EACCES" });
  }
  return lstat(path, ...args);
};
syncBuiltinESMExports();
`,
      );
      const env = {
        STANDIN_ROLE: "operator",
        NODE_OPTIONS: `--import=${networkGuard} --import=${guard}`,
        [variable]: "/inherited-wrong-account",
        STANDIN_LOGIN_CODEX_HOME: "/login-shell-wrong-account",
      };
      const install = f.block("installations/08-coding-agent.md", `command -v ${command}`);
      // Only execute the version check, never the preceding package installation.
      const check = `set +e\n${install.slice(install.indexOf("set -o pipefail"))}`;
      for (const selection of [null, `~/${relative(f.home, f.native)}`]) {
        profile.configDir = selection;
        writeFileSync(settingsPath, JSON.stringify(settings));
        f.run(check, 0, env);
        const call = f.natives().at(-1);
        assert.deepEqual(call.args, ["--version"]);
        assert.equal(call.configDir, selection === null ? undefined : f.native);
        assert.equal(call.role, "service");
      }
      const before = f.natives().length;
      profile.configDir = "/outside-service-home";
      writeFileSync(settingsPath, JSON.stringify(settings));
      f.run(check, 1, env);
      assert.equal(f.natives().length, before);
    });
  }
});

test("rendered failed-cleanup recovery uses root-private resolved snapshots", () => {
  fixture("claude-code", "discord", (f) => {
    f.install();
    f.prepare();
    f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
    f.run(`${f.wrapper} instructions -- false`, 1, {
      STANDIN_FAIL_HARDEN: "1",
      STANDIN_ROLE: "root",
    });
    const retained = f.last.stderr.match(/inventory: (\S+)/u)?.[1];
    assert(retained?.startsWith(`${f.root}/`), f.last.stderr);
    assert(existsSync(join(retained, "0.json")));
    assert.equal(f.state()[retained].owner, "root");
    assert.equal(statSync(retained).mode & 0o777, 0o700);
    const recovery = f
      .block("operations/recover-assistant.md", "harden-snapshot")
      .replace("/tmp/fixture-retained-inventory", retained);
    f.run(recovery);
    assert(existsSync(retained), "Operator retains evidence until verification is complete");
    assert.equal(f.state()[join(f.native, "CLAUDE.md")].immutable, true);
    f.run(`sudo ${f.wrapper} instructions -- true`);
  });
});

test("runbook stand-ins reject outside paths and unapproved commands", () => {
  fixture("pi", "slack", (f) => {
    f.run("sudo install -d -m 755 /etc/runbook-must-not-exist", 1);
    assert(f.last.stderr.includes("OUTSIDE FIXTURE"));
    f.run("rm -rf ../../../../runbook-must-not-exist", 1);
    assert(f.last.stderr.includes("OUTSIDE FIXTURE"));
    f.run("sudo apt install fixture", 1);
    assert(f.last.stderr.includes("UNAPPROVED COMMAND"));
  });
});

function fixture(agent, surface, callback) {
  const root = mkdtempSync(join(tmpdir(), "deployment-runbooks-"));
  const home = join(root, "home/fixture");
  const admin = join(root, "home/operator/admin");
  const bin = join(root, "stand-ins");
  const libexec = join(root, "opt/fixture/libexec");
  const deployed = join(home, ".alignfirst/aligndev.settings.json");
  const native = join(
    home,
    agent === "pi" ? ".pi/agent" : agent === "codex" ? ".codex" : ".claude",
  );
  const journal = join(root, "journal");
  const f = { root, home, admin, libexec, deployed, native };
  f.wrapper = join(root, "usr/local/sbin/alignfirst-assistant-maintenance");
  try {
    for (const path of [home, bin, dirname(f.wrapper)]) mkdirSync(path, { recursive: true });
    cpSync(join(template, "base"), admin, { recursive: true });
    for (const overlay of [`coding-agents/${agent}`, `surfaces/${surface}`])
      cpSync(join(template, "variants", overlay), admin, { recursive: true });
    for (const path of files(admin)) {
      let rendered = render(readFileSync(path, "utf8"), agent, f);
      if (path.endsWith("assistant-maintenance.sh"))
        rendered = rendered.replace(
          `path="/usr/bin:${root}/opt/fixture/bin:/bin:`,
          `path="${bin}:`,
        );
      writeFileSync(path, rendered);
    }
    mkdirSync(dirname(deployed), { recursive: true });
    cpSync(join(admin, "infra/openclaw/aligndev.settings.json"), deployed);
    mkdirSync(join(home, ".openclaw/workspace"), { recursive: true });
    writeFileSync(join(home, ".openclaw/openclaw.json"), "{}\n");
    writeFileSync(journal, `create\troot\t700\t${dirname(admin)}\n`);
    installStandIns(bin, standIns);
    installStandIns(join(admin, "infra/openclaw/bin"), [["assistant-kill.sh", "kill-switch"]]);
    f.env = {
      ...standInEnv({ root, home, bin, journal }),
      HOME: home,
      USER: "fixture",
      LOGNAME: "fixture",
      PATH: bin,
      TMPDIR: root,
      STANDIN_ROLE: "service",
      NODE_OPTIONS: `--import=${networkGuard} --import=${permissionGuard}`,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    f.block = (path, contains) => {
      const matches = shellBlocks(readFileSync(join(admin, "docs", path), "utf8")).filter((block) =>
        block.includes(contains),
      );
      assert.equal(matches.length, 1, `${path}: ${contains}`);
      return matches[0];
    };
    f.run = (script, expected = 0, env = {}) => {
      f.last = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", script], {
        cwd: admin,
        env: { ...f.env, ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(f.last.status, expected, `${script}\n${f.last.stdout}\n${f.last.stderr}`);
      return f.last;
    };
    f.state = () => replayState(readJournal(journal));
    f.natives = () =>
      readJournal(journal)
        .filter(([kind]) => kind === "native")
        .map(([, name, role, present, configDir, apiKey, ...args]) => ({
          name,
          role,
          configDir: present === "1" ? configDir : undefined,
          apiKeyPresent: apiKey === "1",
          args,
        }));
    f.install = () => {
      f.run(
        f.block(
          "installations/03-toolchain.md",
          "deployment-profiles.mjs infra/openclaw/deployment-policy.mjs",
        ),
      );
      f.run(f.block("installations/06-security-hardening.md", "bin/assistant-maintenance.sh"));
      f.run(f.block("installations/04-openclaw.md", "sudo rsync -a --delete"));
    };
    f.prepare = () =>
      f.run(
        `${process.execPath} ${libexec}/deployment-policy.mjs prepare ${deployed} ${home} ${deployed}`,
      );
    callback(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function render(text, agent, f) {
  let rendered = text.replace(/\{\{([A-Z_]+)\}\}/gu, (_, token) => tokens[token] ?? "fixture");
  if (f !== undefined)
    rendered = rendered
      .replaceAll("/home/fixture", f.home)
      .replaceAll("/home/operator/admin", f.admin)
      .replaceAll("~/admin", f.admin)
      .replaceAll("/opt/fixture", join(f.root, "opt/fixture"))
      .replaceAll(
        "/usr/local/sbin/alignfirst-assistant-",
        `${f.root}/usr/local/sbin/alignfirst-assistant-`,
      )
      .replaceAll("/usr/bin/node", process.execPath)
      .replaceAll("/tmp/<retained-inventory>", "/tmp/fixture-retained-inventory");
  return rendered.replace(/<([a-z][a-z0-9|_.-]*)>/gu, (_, value) =>
    value === "stamp"
      ? "fixture-backup"
      : value.includes("claude|")
        ? agent === "claude-code"
          ? "claude"
          : agent
        : "fixture",
  );
}

// The deployment default: the enabled openclaw profile's defaultAgentProfile.
function selectedProfile(settings) {
  return Object.values(settings.code.profiles).find(
    (profile) => profile.harness === "openclaw" && profile.disabled !== true,
  ).defaultAgentProfile;
}

function shellBlocks(markdown) {
  const blocks = [];
  let block;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/^> ?/u, "");
    if (/^\s*```(?:sh|bash|shell)\s*$/u.test(line)) block = [];
    else if (block && /^\s*```\s*$/u.test(line)) {
      blocks.push(block.join("\n"));
      block = undefined;
    } else if (block) block.push(line);
  }
  assert.equal(block, undefined, "Unclosed shell fence");
  return blocks;
}

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
