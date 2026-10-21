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

const repository = fileURLToPath(new URL("../../", import.meta.url));
const template = join(
  repository,
  "skills/alignfirst-setup-guide/assets/aligndev-openclaw-template",
);
const networkGuard = fileURLToPath(
  new URL("fixtures/deployment-deny-network.mjs", import.meta.url),
);
const agents = ["claude-code", "codex", "pi"];

for (const agent of agents) {
  for (const surface of ["discord", "slack"]) {
    test(`${agent}/${surface}: every rendered runbook shell example parses`, () => {
      fixture(agent, surface, (f) => {
        let count = 0;
        for (const path of files(join(f.admin, "docs"))) {
          for (const block of shellBlocks(readFileSync(path, "utf8"))) {
            const result = spawnSync("/bin/bash", ["-n"], { input: block, encoding: "utf8" });
            assert.equal(
              result.status,
              0,
              `${relative(f.admin, path)} block ${count}: ${result.stderr}`,
            );
            ++count;
          }
        }
        assert(count > 80, `Expected substantial runbook coverage, got ${count}`);
      });
    });
  }
}

for (const agent of agents) {
  test(`${agent}: rendered protected-helper install, backup and exact maintenance recovery`, () => {
    fixture(agent, "slack", (f) => {
      f.install();
      f.prepare();
      const native = f.native;
      const instruction = agent === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
      writeFileSync(join(native, instruction), "reviewed instructions\n");
      writeFileSync(join(native, "auth.json"), '{"fixture":"not-a-credential"}\n');
      mkdirSync(join(native, "sessions"));
      writeFileSync(join(native, "sessions/conversation"), "private fixture transcript\n");
      if (agent === "pi") {
        mkdirSync(join(native, "npm/bin"), { recursive: true });
        writeFileSync(join(native, "npm/bin/tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
      const anchors = [f.home, native];
      for (const anchor of anchors) {
        assert.equal(f.state()[anchor].owner, "root");
        assert.equal(f.state()[anchor].mode, 0o1770);
      }
      f.run(f.block("operations/update-assistant.md", "seed/bin/backup.sh"));
      const backups = join(f.home, "backups/deployment");
      const stamp = readdirSync(backups)[0];
      const backup = join(backups, stamp);
      for (const path of files(backup)) assert.equal(statSync(path).mode & 0o077, 0, path);
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
      assert.equal(readFileSync(join(native, instruction), "utf8"), "reviewed instructions\n");
      for (const anchor of anchors) {
        assert.equal(f.state()[anchor].owner, "root");
        assert.equal(
          statSync(anchor).mode & 0o7777,
          0o1770,
          "Recovery must preserve sticky anchors",
        );
      }
      if (agent === "pi") {
        assert(statSync(join(native, "AGENTS.override.md")).isDirectory());
        assert.equal(f.state()[join(native, "AGENTS.override.md")].owner, "root");
        assert((statSync(join(native, "npm/bin/tool")).mode & 0o111) !== 0);
      }
      assert.equal(f.calls().filter(([name]) => name === "kill").length, 4);
      assert(!f.calls().some(([name]) => name === "systemctl"));
      f.run(
        `${process.execPath} ${f.libexec}/deployment-policy.mjs recover ${f.deployed} ${f.home} ${f.deployed} ${backup}/native`,
        1,
      );
      assert(f.last.stderr.includes("PERMISSION MODEL"), "Recovery outside maintenance must fail");
    });
  });
}

test("native-default rendered Codex authentication removes login-shell routing and preserves explicit strings", () => {
  for (const selection of [null, "~/.codex", "../native/custom codex"]) {
    fixture("codex", "slack", (f) => {
      f.install();
      const settings = JSON.parse(readFileSync(f.deployed, "utf8"));
      settings.code.profiles[settings.code.profile].configDir = selection;
      writeFileSync(f.deployed, JSON.stringify(settings));
      const block = f.block("installations/08-coding-agent.md", "codex login --device-auth");
      const interactive = block.replace(
        "sudo -i -u fixture\n",
        "sudo -H -u fixture bash -l <<'NATIVE_LOGIN'\n",
      );
      assert.notEqual(interactive, block, "Replace only the interactive account-shell entry");
      f.run(`${interactive}\nNATIVE_LOGIN`, 0, {
        CODEX_HOME: "/inherited-wrong-account",
        RUNBOOK_LOGIN_CODEX_HOME: "/login-shell-wrong-account",
      });
      const calls = readFileSync(join(f.root, "native-calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["login", "--device-auth"],
          ["login", "status"],
        ],
      );
      for (const call of calls) {
        assert.equal(call.present, selection !== null);
        assert.equal(
          call.configDir,
          selection === null
            ? undefined
            : selection === "~/.codex"
              ? f.native
              : join(f.home, "native/custom codex"),
        );
        assert.equal(call.apiKeyPresent, false);
      }
    });
  }
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
      const profile = settings.code.profiles[settings.code.profile];
      const guard = join(f.root, "private-home.mjs");
      writeFileSync(
        guard,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (process.env.RUNBOOK_ROLE === "service" &&
      String(path).startsWith(${JSON.stringify(f.admin)} + "/")) {
    throw Object.assign(new Error("EACCES: private admin repository"), { code: "EACCES" });
  }
  return read(path, ...args);
};
const lstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  if (process.env.RUNBOOK_ROLE === "operator" &&
      String(path).startsWith(process.env.RUNBOOK_HOME + "/")) {
    throw Object.assign(new Error("EACCES: private service home"), { code: "EACCES" });
  }
  return lstat(path, ...args);
};
syncBuiltinESMExports();
`,
      );
      const env = {
        RUNBOOK_ROLE: "operator",
        NODE_OPTIONS: `--import=${networkGuard} --import=${guard}`,
        [variable]: "/inherited-wrong-account",
        RUNBOOK_LOGIN_CODEX_HOME: "/login-shell-wrong-account",
      };
      const install = f.block("installations/08-coding-agent.md", `command -v ${command}`);
      // Only execute the version check, never the preceding package installation.
      const check = `set +e\n${install.slice(install.indexOf("set -o pipefail"))}`;
      const inventory = `${process.execPath} infra/openclaw/deployment-profiles.mjs "${settingsPath}" "${f.home}" "${f.deployed}"`;
      f.run(inventory, 1, env);
      assert.match(f.last.stderr, /EACCES: private service home/u);
      f.run(inventory, 1, { ...env, RUNBOOK_ROLE: "service" });
      assert.match(f.last.stderr, /EACCES: private admin repository/u);
      for (const selection of [null, `~/${relative(f.home, f.native)}`]) {
        profile.configDir = selection;
        writeFileSync(settingsPath, JSON.stringify(settings));
        f.run(check, 0, env);
        const call = JSON.parse(
          readFileSync(join(f.root, "native-calls.jsonl"), "utf8").trim().split("\n").at(-1),
        );
        assert.deepEqual(call.args, ["--version"]);
        assert.equal(call.present, selection !== null);
        assert.equal(call.configDir, selection === null ? undefined : f.native);
        assert.equal(call.role, "service");
      }
      const before = readFileSync(join(f.root, "native-calls.jsonl"), "utf8");
      profile.configDir = "/outside-service-home";
      writeFileSync(settingsPath, JSON.stringify(settings));
      f.run(check, 1, env);
      assert.equal(readFileSync(join(f.root, "native-calls.jsonl"), "utf8"), before);
    });
  }
});

test("native recovery reads a protected reviewed copy while the admin home stays denied", () => {
  fixture("pi", "slack", (f) => {
    f.install();
    f.prepare();
    writeFileSync(join(f.native, "AGENTS.md"), "reviewed backup\n");
    f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
    f.run(f.block("operations/update-assistant.md", "seed/bin/backup.sh"));
    f.run(
      `${process.execPath} --input-type=module -e 'import { readFileSync } from "node:fs"; readFileSync("${f.admin}/infra/openclaw/aligndev.settings.json");'`,
      1,
    );
    assert(f.last.stderr.includes("PERMISSION MODEL: search denied"));
    const stamp = readdirSync(join(f.home, "backups/deployment"))[0];
    f.run(`sudo ${f.wrapper} native-recovery -- ${f.home}/backups/deployment/${stamp}/native`);
    assert.equal(readFileSync(join(f.native, "AGENTS.md"), "utf8"), "reviewed backup\n");
    const copy = f
      .calls()
      .find(([name, ...args]) => name === "install" && args.at(-1).endsWith("/settings.json"))
      ?.at(-1);
    assert(copy, "Recovery must use a dedicated reviewed settings copy");
    assert.equal(f.state()[copy].owner, "root");
    assert.equal(f.state()[dirname(copy)].owner, "root");
    assert.equal(f.state()[dirname(copy)].mode & 0o022, 0);
    assert(!existsSync(dirname(copy)), "Readable temporary settings are removed after recovery");
    assert.equal(f.state()[dirname(f.admin)].mode, 0o700);
  });
});

test("native recovery snapshots lost external declarations before unlock and restores policy on failure", () => {
  for (const failure of [false, true])
    fixture("pi", "discord", (f) => {
      f.install();
      f.prepare();
      const external = join(f.home, "reviewed-extension.ts");
      const skills = join(f.home, "reviewed-skills");
      writeFileSync(external, "reviewed external extension\n");
      mkdirSync(skills);
      writeFileSync(join(skills, "SKILL.md"), "reviewed skill\n");
      writeFileSync(
        join(f.native, "settings.json"),
        JSON.stringify({
          extensions: [external],
          skills: [skills],
        }),
      );
      f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
      f.run(f.block("operations/update-assistant.md", "seed/bin/backup.sh"));
      rmSync(join(f.native, "settings.json"));
      writeFileSync(join(f.native, "auth.json"), "post-backup content\n");
      const start = f.calls().length;
      const stamp = readdirSync(join(f.home, "backups/deployment"))[0];
      f.run(
        `sudo ${f.wrapper} native-recovery -- ${f.home}/backups/deployment/${stamp}/native`,
        failure ? 1 : 0,
        failure ? { RUNBOOK_FAIL_RECOVERY_COPY: "1" } : {},
      );
      const calls = f.calls().slice(start);
      const service = calls.findIndex(([name]) => name === "runuser");
      for (const path of [external, join(skills, "SKILL.md")]) {
        assert(
          calls
            .slice(0, service)
            .some(([name, flag, target]) => name === "chattr" && flag === "-i" && target === path),
          `Backup-derived resource must be unlocked before service recovery: ${path}`,
        );
        assert.equal(f.state()[path].owner, "root");
        assert.equal(f.state()[path].immutable, true);
      }
      if (!failure) assert.equal(readFileSync(external, "utf8"), "reviewed external extension\n");
      assert.equal(readFileSync(join(skills, "SKILL.md"), "utf8"), "reviewed skill\n");
      assert.equal(f.calls().filter(([name]) => name === "kill").length, 4);
      if (failure) assert(f.last.stderr.includes("Injected external recovery copy failure"));
      else assert(f.last.stdout.includes("hardening restored; gateway remains stopped"));
    });
});

test("rendered failed-cleanup recovery uses root-private resolved snapshots", () => {
  fixture("pi", "discord", (f) => {
    f.install();
    f.prepare();
    f.run(f.block("installations/06-security-hardening.md", "deployment-policy.mjs harden"));
    f.run(`${f.wrapper} agent-config -- false`, 1, {
      RUNBOOK_FAIL_HARDEN: "1",
      RUNBOOK_ROLE: "root",
    });
    const retained = f.last.stderr.match(/inventory: (\S+)/u)?.[1];
    assert(retained?.startsWith(`${f.root}/`), f.last.stderr);
    assert(existsSync(join(retained, "0.json")));
    assert.equal(f.state()[retained].owner, "root");
    assert.equal(statSync(retained).mode & 0o777, 0o700);
    f.run(
      `${process.execPath} --input-type=module -e 'import { readFileSync } from "node:fs"; readFileSync("${retained}/0.json");'`,
      1,
    );
    assert.match(f.last.stderr, /PERMISSION MODEL: (read|search) denied/u);
    const recovery = f
      .block("operations/recover-assistant.md", "harden-snapshot")
      .replace("/tmp/fixture-retained-inventory", retained);
    f.run(recovery);
    assert(existsSync(retained), "Operator retains evidence until verification is complete");
    const calls = f.calls();
    assert(calls.some(([name, ...args]) => name === "chattr" && args.includes("+i")));
    f.run(`sudo ${f.wrapper} agent-config -- true`);
  });
});

test("runbook doubles reject outside paths and unapproved commands", () => {
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
  const bin = join(root, "doubles");
  const libexec = join(root, "opt/fixture/libexec");
  const deployed = join(home, ".alignfirst/aligndev.settings.json");
  const native = join(
    home,
    agent === "pi" ? ".pi/agent" : agent === "codex" ? ".codex" : ".claude",
  );
  const stateFile = join(root, "permissions.json");
  const log = join(root, "calls.jsonl");
  const f = { root, home, admin, bin, libexec, deployed, native, log, stateFile };
  f.wrapper = join(root, "usr/local/sbin/alignfirst-assistant-maintenance");
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(bin);
    cpSync(join(template, "base"), admin, { recursive: true });
    for (const overlay of [`coding-agents/${agent}`, `surfaces/${surface}`])
      cpSync(join(template, "variants", overlay), admin, { recursive: true });
    for (const path of files(admin)) {
      const source = readFileSync(path, "utf8");
      let rendered = render(source, f, agent);
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
    writeFileSync(
      stateFile,
      JSON.stringify({
        [dirname(admin)]: { owner: "root", mode: 0o700 },
      }),
    );
    const guard = join(root, "permission-guard.mjs");
    writeFileSync(
      guard,
      `import fs from 'node:fs';\nimport { dirname, join, resolve } from 'node:path';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { fileURLToPath } from 'node:url';\n(${permissionGuard.toString()})();\n`,
    );
    f.env = {
      HOME: home,
      USER: "fixture",
      LOGNAME: "fixture",
      PATH: bin,
      TMPDIR: root,
      RUNBOOK_ROOT: root,
      RUNBOOK_HOME: home,
      RUNBOOK_STATE: stateFile,
      RUNBOOK_LOG: log,
      RUNBOOK_BIN: bin,
      RUNBOOK_ROLE: "service",
      NODE_OPTIONS: `--import=${networkGuard} --import=${guard}`,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    const double = `#!${process.execPath}\nimport fs from 'node:fs';\nimport { basename, dirname, join, resolve } from 'node:path';\nimport { spawnSync } from 'node:child_process';\n(${commandDouble.toString()})();\n`;
    for (const name of [
      "sudo",
      "install",
      "id",
      "rsync",
      "chown",
      "chmod",
      "chattr",
      "runuser",
      "openclaw",
      "claude",
      "codex",
      "pi",
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
    ])
      writeFileSync(join(bin, name), double, { mode: 0o755 });
    writeFileSync(join(admin, "infra/openclaw/bin/assistant-kill.sh"), double, { mode: 0o755 });
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
    f.state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    f.calls = () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
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

function render(text, f, agent) {
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
  };
  return text
    .replace(/\{\{([A-Z_]+)\}\}/gu, (_, token) => tokens[token] ?? "fixture")
    .replaceAll("/home/fixture", f.home)
    .replaceAll("/home/operator/admin", f.admin)
    .replaceAll("~/admin", f.admin)
    .replaceAll("/opt/fixture", join(f.root, "opt/fixture"))
    .replaceAll(
      "/usr/local/sbin/alignfirst-assistant-",
      `${f.root}/usr/local/sbin/alignfirst-assistant-`,
    )
    .replaceAll("/usr/bin/node", process.execPath)
    .replaceAll("/tmp/<retained-inventory>", "/tmp/fixture-retained-inventory")
    .replace(/<([a-z][a-z0-9|_.-]*)>/gu, (_, value) =>
      value === "stamp"
        ? "fixture-backup"
        : value.includes("claude|")
          ? agent === "claude-code"
            ? "claude"
            : agent
          : "fixture",
    );
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

// The model enforces ownership, immutable children and sticky-parent deletion for service Node
// commands. It is deliberately separate from real OS enforcement, which remains host acceptance.
function permissionGuard() {
  const root = process.env.RUNBOOK_ROOT;
  const stateFile = process.env.RUNBOOK_STATE;
  const role = process.env.RUNBOOK_ROLE;
  const original = { ...fs };
  function inside(path) {
    const value = resolve(String(path));
    if (value !== root && !value.startsWith(`${root}/`))
      throw new Error(`OUTSIDE FIXTURE: ${value}`);
    return value;
  }
  function state() {
    return JSON.parse(original.readFileSync(stateFile, "utf8"));
  }
  function save(value) {
    original.writeFileSync(stateFile, JSON.stringify(value));
  }
  function info(path) {
    return state()[path] ?? { owner: "service", mode: 0o700 };
  }
  function readable(path) {
    if (role === "root") return;
    let parent = dirname(path);
    while (parent.startsWith(`${root}/`)) {
      const entry = info(parent);
      if (!(entry.mode & (entry.owner === "root" ? 0o010 : 0o100)))
        throw new Error(`PERMISSION MODEL: search denied ${parent} for ${path}`);
      parent = dirname(parent);
    }
    const entry = info(path);
    if (!(entry.mode & (entry.owner === "root" ? 0o040 : 0o400)))
      throw new Error(`PERMISSION MODEL: read denied ${path}`);
  }
  function writable(path) {
    if (role === "root") return;
    const value = info(path);
    if (value.immutable || !(value.mode & (value.owner === "root" ? 0o020 : 0o200)))
      throw new Error(`PERMISSION MODEL: write denied ${path}`);
  }
  function create(path) {
    inside(path);
    if (original.existsSync(path)) return;
    let parent = dirname(path);
    while (!original.existsSync(parent)) parent = dirname(parent);
    writable(parent);
  }
  function record(path) {
    const entries = state();
    entries[path] = { owner: role, mode: original.statSync(path).mode & 0o7777 };
    save(entries);
  }
  function remove(path) {
    inside(path);
    if (!original.existsSync(path)) return;
    if (role !== "root") {
      writable(dirname(path));
      const entry = info(path);
      if (entry.immutable || (info(dirname(path)).mode & 0o1000 && entry.owner === "root"))
        throw new Error(`PERMISSION MODEL: removal denied ${path}`);
    }
    if (original.lstatSync(path).isDirectory())
      for (const name of original.readdirSync(path)) remove(join(path, name));
  }
  fs.mkdirSync = (input, options) => {
    const path = inside(input);
    create(path);
    const existed = original.existsSync(path);
    const result = original.mkdirSync(path, options);
    if (!existed) record(path);
    return result;
  };
  fs.writeFileSync = (input, ...args) => {
    const path = inside(input);
    if (path === stateFile || path === process.env.RUNBOOK_LOG)
      return original.writeFileSync(path, ...args);
    const existed = original.existsSync(path);
    if (existed) writable(path);
    else create(path);
    const result = original.writeFileSync(path, ...args);
    if (!existed) record(path);
    return result;
  };
  fs.rmSync = (input, options) => {
    const path = inside(input);
    remove(path);
    return original.rmSync(path, options);
  };
  fs.chmodSync = (input, mode) => {
    const path = inside(input);
    if (role !== "root" && info(path).owner === "root")
      throw new Error(`PERMISSION MODEL: chmod denied ${path}`);
    return original.chmodSync(path, mode);
  };
  fs.cpSync = (inputSource, inputDestination, options) => {
    const source = inside(inputSource);
    const destination = inside(inputDestination);
    if (
      role !== "root" &&
      process.env.RUNBOOK_FAIL_RECOVERY_COPY === "1" &&
      /\/native\/resource-\d+$/u.test(source)
    )
      throw new Error("Injected external recovery copy failure");
    const copied = [];
    function check(src, dest) {
      readable(src);
      const existed = original.existsSync(dest);
      if (original.lstatSync(src).isDirectory()) {
        if (!existed) {
          create(dest);
          copied.push(dest);
        }
        for (const name of original.readdirSync(src)) check(join(src, name), join(dest, name));
      } else {
        if (existed) writable(dest);
        else create(dest);
        copied.push(dest);
      }
    }
    check(source, destination);
    const result = original.cpSync(source, destination, options);
    for (const path of copied) if (!original.lstatSync(path).isSymbolicLink()) record(path);
    return result;
  };
  fs.readFileSync = (input, ...args) => {
    const path = resolve(input instanceof URL ? fileURLToPath(input) : String(input));
    if (path.startsWith(`${root}/`)) readable(path);
    return original.readFileSync(input, ...args);
  };
  process.getuid = () => (role === "root" ? 0 : 1000);
  syncBuiltinESMExports();
}

function commandDouble() {
  const root = process.env.RUNBOOK_ROOT;
  const home = process.env.RUNBOOK_HOME;
  const bin = process.env.RUNBOOK_BIN;
  const basenameValue = basename(process.argv[1]);
  const name = basenameValue === "alignfirst-assistant-kill" ? "kill" : basenameValue;
  let args = process.argv.slice(2);
  const stateFile = process.env.RUNBOOK_STATE;
  function inside(path) {
    const resolved = resolve(path);
    if (resolved !== root && !resolved.startsWith(`${root}/`))
      throw new Error(`OUTSIDE FIXTURE: ${resolved}`);
    return resolved;
  }
  function update(path, values) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state[path] = {
      owner: "service",
      mode: fs.statSync(path).mode & 0o7777,
      ...state[path],
      ...values,
    };
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  function execute(command, argv, env = process.env) {
    if (command.startsWith(root)) {
      inside(command);
      if (!fs.existsSync(command)) throw new Error(`UNAPPROVED COMMAND: ${command}`);
    } else if (command !== process.execPath && command !== "/bin/bash")
      throw new Error(`UNAPPROVED COMMAND: ${command}`);
    const child = spawnSync(command, argv, { env, stdio: "inherit", cwd: process.cwd() });
    process.exit(child.status ?? 1);
  }
  function checkedPaths(values) {
    for (const value of values) if (value.startsWith("/")) inside(value);
  }
  fs.appendFileSync(process.env.RUNBOOK_LOG, `${JSON.stringify([name, ...args])}\n`);
  if (name === "true" || name === "false") {
    if (args.length !== 0) throw new Error("Unexpected status-command arguments");
    process.exit(name === "true" ? 0 : 1);
  } else if (name === "kill") {
    if (args.length !== 0) throw new Error("Unexpected kill-switch arguments");
  } else if (name === "sudo") {
    let role = "root";
    while (args[0]?.startsWith("-")) {
      const flag = args.shift();
      if (flag === "-u") {
        if (args.shift() !== "fixture") throw new Error("Unexpected account");
        role = "service";
      } else if (!["-H", "-i", "--"].includes(flag)) throw new Error("Unexpected sudo flag");
    }
    const command = args.shift();
    execute(command.startsWith("/") ? command : join(bin, command), args, {
      ...process.env,
      HOME: role === "root" ? root : home,
      RUNBOOK_ROLE: role,
    });
  } else if (name === "bash") {
    const env = { ...process.env };
    if (
      args.some((arg) => ["-l", "--login", "-lc"].includes(arg)) &&
      env.RUNBOOK_LOGIN_CODEX_HOME !== undefined
    ) {
      env.CODEX_HOME = env.RUNBOOK_LOGIN_CODEX_HOME;
      env.CODEX_API_KEY = "offline-key-marker";
      env.OPENAI_API_KEY = "offline-key-marker";
    }
    execute(
      "/bin/bash",
      args
        .filter((arg) => !["-l", "--login"].includes(arg))
        .map((arg) => (arg === "-lc" ? "-c" : arg)),
      env,
    );
  } else if (name === "id") {
    if (args.join(" ") === "-u") console.log(process.env.RUNBOOK_ROLE === "root" ? "0" : "1000");
    else if (["-u fixture", "-gn fixture", "-un"].includes(args.join(" ")))
      console.log(args[0] === "-u" ? "1000" : "fixture");
    else throw new Error("Unexpected id");
  } else if (name === "install") {
    let mode = 0o755;
    let directory = false;
    while (args[0]?.startsWith("-")) {
      const flag = args.shift();
      if (flag === "-m") mode = Number.parseInt(args.shift(), 8);
      else if (["-o", "-g"].includes(flag)) {
        if (!["root", "fixture"].includes(args.shift())) throw new Error("Unexpected owner");
      } else if (flag === "-d") directory = true;
      else if (flag !== "-D") throw new Error("Unexpected install flag");
    }
    args = args.map(inside);
    if (directory) {
      for (const target of args) {
        fs.mkdirSync(target, { recursive: true });
        fs.chmodSync(target, mode);
        update(target, { owner: process.env.RUNBOOK_ROLE, mode });
      }
    } else {
      const destination = args.pop();
      for (const source of args) {
        const target =
          fs.existsSync(destination) && fs.statSync(destination).isDirectory()
            ? join(destination, basename(source))
            : destination;
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.cpSync(source, target);
        fs.chmodSync(target, mode);
        update(target, { owner: process.env.RUNBOOK_ROLE, mode });
      }
    }
  } else if (["chattr", "chown", "chmod"].includes(name)) {
    const recursive = args[0] === "-R" || args[0] === "-Rh";
    if (recursive) args.shift();
    const value = args.shift();
    checkedPaths(args);
    if (name === "chattr" && !["+i", "-i"].includes(value)) throw new Error("Unexpected chattr");
    if (name === "chown" && !["root:root", "root:fixture", "fixture:fixture"].includes(value))
      throw new Error("Unexpected chown");
    if (name === "chattr" && value === "+i" && process.env.RUNBOOK_FAIL_HARDEN === "1")
      process.exit(1);
    function apply(path) {
      inside(path);
      if (name === "chattr") update(path, { immutable: value === "+i" });
      if (name === "chown") update(path, { owner: value.startsWith("root:") ? "root" : "service" });
      if (name === "chmod") {
        const before = fs.statSync(path).mode & 0o7777;
        const mode =
          value === "go-rwx"
            ? before & ~0o077
            : value === "go-w"
              ? before & ~0o022
              : Number.parseInt(value, 8);
        if (!Number.isInteger(mode)) throw new Error("Unexpected mode");
        fs.chmodSync(path, mode);
        update(path, { mode });
      }
      if (recursive && fs.lstatSync(path).isDirectory())
        for (const child of fs.readdirSync(path)) apply(join(path, child));
    }
    for (const path of args) apply(path);
  } else if (name === "rsync") {
    if (args.length !== 4 || args[0] !== "-a" || args[1] !== "--delete")
      throw new Error("Unexpected rsync");
    const source = inside(args[2]);
    const destination = inside(args[3]);
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(destination))
      fs.rmSync(join(destination, entry), { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
  } else if (name === "runuser") {
    if (args[0] !== "-u" || args[1] !== "fixture" || args[2] !== "--" || args[3] !== "env")
      throw new Error("Unexpected runuser");
    args = args.slice(4);
    const env = { ...process.env, RUNBOOK_ROLE: "service" };
    while (args[0]?.includes("=")) {
      const [key, ...value] = args.shift().split("=");
      env[key] = value.join("=");
    }
    if (env.HOME !== home || env.PATH.includes("/usr/bin"))
      throw new Error("Unsafe service environment");
    execute(join(bin, args.shift()), args, env);
  } else if (["claude", "codex", "pi"].includes(name)) {
    if (
      args.join(" ") !== "--version" &&
      !(name === "codex" && ["login --device-auth", "login status"].includes(args.join(" ")))
    )
      throw new Error("Unexpected offline native command");
    const variable = {
      claude: "CLAUDE_CONFIG_DIR",
      codex: "CODEX_HOME",
      pi: "PI_CODING_AGENT_DIR",
    }[name];
    fs.appendFileSync(
      join(root, "native-calls.jsonl"),
      `${JSON.stringify({
        args,
        role: process.env.RUNBOOK_ROLE,
        present: Object.hasOwn(process.env, variable),
        configDir: process.env[variable],
        apiKeyPresent:
          Object.hasOwn(process.env, "CODEX_API_KEY") ||
          Object.hasOwn(process.env, "OPENAI_API_KEY"),
      })}\n`,
    );
  } else if (name === "openclaw") {
    if (
      args.length !== 6 ||
      args.slice(0, 3).join(" ") !== "backup create --output" ||
      args[4] !== "--no-include-workspace" ||
      args[5] !== "--verify"
    )
      throw new Error("Unexpected OpenClaw command");
    inside(args[3]);
    fs.writeFileSync(join(args[3], "fixture-openclaw-backup.tar.gz"), "offline archive double\n");
  } else if (name === "mktemp") {
    let path;
    if (args.join(" ") === "-d") path = fs.mkdtempSync(join(root, "tmp."));
    else if (args.length === 2 && args[0] === "-d")
      path = fs.mkdtempSync(inside(args[1]).replace(/X+$/u, ""));
    else throw new Error("Unexpected mktemp");
    update(path, { owner: process.env.RUNBOOK_ROLE });
    console.log(path);
  } else if (name === "date") {
    if (args.join(" ") !== "+%Y%m%d-%H%M%S") throw new Error("Unexpected date");
    console.log("20000101-000000");
  } else if (name === "stat") {
    if (args.length !== 3 || args[0] !== "-c" || args[1] !== "%u:%a")
      throw new Error("Unexpected stat");
    const path = inside(args[2]);
    const entry = JSON.parse(fs.readFileSync(stateFile, "utf8"))[path];
    console.log(
      `${entry.owner === "root" ? 0 : 1000}:${(fs.statSync(path).mode & 0o777).toString(8)}`,
    );
  } else if (["find", "cmp", "rm", "jq"].includes(name)) {
    checkedPaths(args);
    if (name === "rm" || name === "cmp")
      for (const argument of args) if (!argument.startsWith("-")) inside(argument);
    if (name === "find") inside(args[0]);
    if (name === "find" && args.some((arg) => ["-exec", "-execdir", "-delete"].includes(arg)))
      throw new Error("Unexpected find mutation");
    const child = spawnSync(`/usr/bin/${name}`, args, { env: process.env, stdio: "inherit" });
    process.exit(child.status ?? 1);
  } else throw new Error(`UNAPPROVED COMMAND: ${name}`);
}
