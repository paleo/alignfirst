import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const template = fileURLToPath(
  new URL(
    "../../skills/alignfirst-setup-guide/assets/aligndev-openclaw-template/",
    import.meta.url,
  ),
);
const guard = fileURLToPath(new URL("fixtures/deployment-deny-network.mjs", import.meta.url));
// Base-branch deployed shapes, deliberately not derived from the new profile overlays.
const legacySettings = {
  "claude-code": {
    platform: "openclaw",
    projectsRoot: "~/projects",
    code: { agent: "claude", skipPermissions: true, unset: ["ANTHROPIC_API_KEY"] },
  },
  codex: {
    platform: "openclaw",
    projectsRoot: "~/projects",
    code: {
      agent: "codex",
      skipPermissions: true,
      unset: [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_HOME",
        "CODEX_MANAGED_PACKAGE_ROOT",
        "CODEX_MANAGED_BY_NPM",
      ],
    },
  },
};

for (const agent of Object.keys(legacySettings)) {
  test(`${agent}: rendered bootstrap precedes seed replacement and profile-only backup`, () => {
    fixture(agent, (f) => {
      const original = snapshot(f.home);
      runSection(f, "Maintenance controls");
      runSection(f, "Bootstrap backup before conversion", 0);
      assert.deepEqual(snapshot(f.home), original, "Bootstrap must not migrate deployed state");
      const backup = onlyBackup(f, "bootstrap");
      assert(existsSync(join(backup, "COMPLETE")));
      for (const path of [join(f.home, "backups"), dirname(backup), backup]) {
        assert.equal(lstatSync(path).mode & 0o777, 0o700);
      }
      for (const name of readdirSync(backup)) {
        assert.equal(lstatSync(join(backup, name)).mode & 0o777, 0o600);
      }
      const staging = join(f.root, "private-staging");
      mkdirSync(staging, { mode: 0o700 });
      run(f, "tar", [
        "--extract",
        "--gzip",
        "--same-permissions",
        "--no-same-owner",
        "--file",
        join(backup, "service-home.tar.gz"),
        "--directory",
        staging,
      ]);
      assert.deepEqual(snapshot(staging), original, "Every original file, mode and link survives");
      assert(!existsSync(join(staging, "backups")), "Never recursively archive previous backups");
      runSection(f, "Bootstrap backup before conversion", 1);
      assert.equal(readFileSync(f.deployed, "utf8"), f.originalSettings);
      assert(!existsSync(join(f.home, "seed/old-seed-only")), "Execute the actual seed refresh");
      runSection(f, "One-time: convert direct launch settings");
      assert.deepEqual(JSON.parse(readFileSync(f.deployed, "utf8")), f.reviewedSettings);
      // The runbook requires operator-reviewed replacement of former Claude native skill links.
      if (agent === "claude-code") {
        rmSync(join(f.native, "skills/sharp-writing"));
        cpSync(
          join(f.home, ".agents/skills/sharp-writing"),
          join(f.native, "skills/sharp-writing"),
          {
            recursive: true,
          },
        );
      }
      runSection(f, "Back up");
      const mapped = onlyBackup(f, "deployment");
      assert(existsSync(join(mapped, "native/mapping.json")));
      assert(existsSync(join(mapped, "fixture-openclaw-backup.tar.gz")));
      for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
        assert.equal(
          readFileSync(join(mapped, "thread-handoff", name), "utf8"),
          `original ${name}\n`,
        );
      }
      assert.equal(
        readFileSync(join(staging, ".alignfirst/aligndev.settings.json"), "utf8"),
        f.originalSettings,
        "Mapped backup cannot replace the original legacy recovery point",
      );
      const events = readFileSync(f.log, "utf8");
      assert(events.indexOf("kill\n") < events.indexOf("tar:create\n"));
      assert(events.indexOf("tar:list\n") < events.indexOf("rsync\n"));
      assert(events.indexOf("rsync\n") < events.indexOf("chattr:-i\n"));
      assert(events.indexOf("chattr:+i\n") < events.indexOf("openclaw\n"));
    });
  });

  test(`${agent}: ordinary backup ignores retired fields but requires an explicit provisioned profile`, () => {
    fixture(agent, (f) => {
      runSection(f, "Maintenance controls");
      const result = run(f, "bash", [join(f.infra, "bin/backup.sh")], {}, false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /code.agent.*Retired launch setting.*manual conversion/u);
      assert.match(result.stderr, /an explicit code.profile must name a provisioned profile/u);
      assert.equal(readFileSync(f.deployed, "utf8"), f.originalSettings);
      assert(!readFileSync(f.log, "utf8").includes("openclaw\n"));
    });
  });
}

for (const failure of ["create", "list"]) {
  test(`bootstrap tar ${failure} failure leaves no completed recovery point; retry is independent`, () => {
    fixture("codex", (f) => {
      const original = snapshot(f.home);
      runSection(f, "Maintenance controls");
      const failed = run(
        f,
        "bash",
        ["--noprofile", "--norc", "-euc", section(f, "Bootstrap backup before conversion")[0]],
        { FAIL_TAR: failure },
        false,
      );
      assert.notEqual(failed.status, 0);
      const partial = onlyBackup(f, "bootstrap");
      assert(!existsSync(join(partial, "COMPLETE")));
      assert(!existsSync(join(partial, "service-home.tar.gz")));
      assert.deepEqual(snapshot(f.home), original);
      assert(!readFileSync(f.log, "utf8").includes("rsync\n"));
      runSection(f, "Bootstrap backup before conversion", 0);
      const attempts = readdirSync(join(f.home, "backups/bootstrap"));
      assert.equal(attempts.length, 2);
      assert.equal(
        attempts.filter((name) => existsSync(join(f.home, "backups/bootstrap", name, "COMPLETE")))
          .length,
        1,
      );
    });
  });
}

for (const destination of ["backups", "backups/bootstrap"]) {
  test(`bootstrap rejects a symlinked ${destination} destination`, () => {
    fixture("codex", (f) => {
      runSection(f, "Maintenance controls");
      const target = join(f.root, "untouched");
      mkdirSync(target);
      rmSync(join(f.home, destination), { recursive: true, force: true });
      mkdirSync(dirname(join(f.home, destination)), { recursive: true });
      symlinkSync(target, join(f.home, destination));
      const result = run(
        f,
        "bash",
        ["--noprofile", "--norc", "-euc", section(f, "Bootstrap backup before conversion")[0]],
        {},
        false,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be symlinks/u);
      assert.deepEqual(readdirSync(target), []);
      assert.equal(readFileSync(f.deployed, "utf8"), f.originalSettings);
    });
  });
}

function fixture(agent, callback) {
  const root = mkdtempSync(join(tmpdir(), "deployment-bootstrap-"));
  const f = {
    root,
    home: join(root, "home"),
    admin: join(root, "admin"),
    bin: join(root, "bin"),
    log: join(root, "calls"),
    native: join(root, "home", agent === "codex" ? ".codex" : ".claude"),
    deployed: join(root, "home/.alignfirst/aligndev.settings.json"),
    infra: join(root, "admin/infra/openclaw"),
    originalSettings: `${JSON.stringify(legacySettings[agent], null, 2)}\n`,
  };
  try {
    for (const path of [f.home, f.admin, f.bin, join(root, "usr/local/sbin")])
      mkdirSync(path, { recursive: true });
    cpSync(join(template, "base"), f.admin, { recursive: true });
    cpSync(join(template, "variants/coding-agents", agent), f.admin, { recursive: true });
    for (const path of files(f.admin)) {
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll("{{SERVICE_USER}}", "fixture")
          .replaceAll("{{ADMIN_REPOSITORY_NAME}}", "admin")
          .replaceAll("/home/fixture", f.home)
          .replaceAll("~/admin", f.admin)
          .replaceAll("/opt/fixture", join(root, "opt/fixture"))
          .replaceAll(
            "/usr/local/sbin/alignfirst-assistant-",
            `${root}/usr/local/sbin/alignfirst-assistant-`,
          )
          .replaceAll("/usr/bin/node", process.execPath),
      );
    }
    f.reviewedSettings = JSON.parse(readFileSync(join(f.infra, "aligndev.settings.json"), "utf8"));
    put(f.deployed, f.originalSettings);
    for (const [path, text] of Object.entries({
      "seed/old-seed-only": "original seed\n",
      "seed/.env": "original fixture env\n",
      ".openclaw/openclaw.json": '{"original":true}\n',
      ".openclaw/secrets/secrets.json": '{"fake":"not-a-credential"}\n',
      ".openclaw/.env": "fixture-only\n",
      ".openclaw/workspace/AGENTS.md": "original workspace\n",
      ".openclaw/workspace/scratch/keep.bin": "original scratch\n",
      ".openclaw/state/sessions.sqlite-wal": "original OpenClaw WAL\n",
      ".config/environment.d/common.conf": "ORIGINAL=1\n",
      ".config/systemd/user/openclaw-gateway.service": "original unit\n",
      ".alignfirst/companions/registry.json": '{"projects":{}}\n',
      ".alignfirst/companions/project/docs/keep.md": "original companion\n",
      ".agents/skills/sharp-writing/SKILL.md": "original shared skill\n",
      "projects/.alignfirst-projects.json": '{"portRange":[28000,28599]}\n',
      "projects/work-files/.plans/ticket.md": "original work files\n",
      ".npm-system-global/bin/tool": "original protected package\n",
      ".local/share/fnm/aliases/default": "original project runtime\n",
      ".claude.json": '{"originalSavedTrust":true}\n',
    }))
      put(join(f.home, path), text);
    for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
      put(join(f.home, ".openclaw/thread-handoff", name), `original ${name}\n`);
    }
    put(join(f.native, "auth.json"), '{"fake":"original-native-auth"}\n');
    put(join(f.native, "sessions/original.jsonl"), "original native session\n");
    put(
      join(f.native, agent === "codex" ? "config.toml" : "settings.json"),
      agent === "codex" ? '[projects."fixture"]\ntrust_level = "trusted"\n' : "{}\n",
    );
    put(join(f.native, "trust.json"), '{"original":true}\n');
    put(join(f.native, "skills/executable/run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(f.native, "skills/executable/run.sh"), 0o751);
    if (agent === "claude-code")
      symlinkSync("../../.agents/skills/sharp-writing", join(f.native, "skills/sharp-writing"));
    mkdirSync(join(f.home, "backups/previous"), { recursive: true });
    put(join(f.home, "backups/previous/keep"), "excluded previous backup\n");
    put(f.log, "");
    put(join(f.bin, "double.mjs"), commandDouble());
    for (const name of [
      "sudo",
      "git",
      "install",
      "id",
      "chattr",
      "chown",
      "rsync",
      "openclaw",
      "tar",
    ]) {
      put(join(f.bin, name), `#!${process.execPath}\nimport "./double.mjs";\n`);
      chmodSync(join(f.bin, name), 0o755);
    }
    f.env = {
      HOME: f.home,
      USER: "fixture",
      LOGNAME: "fixture",
      PATH: `${f.bin}:/usr/bin:/bin`,
      FIXTURE_ROOT: root,
      FIXTURE_HOME: f.home,
      FIXTURE_LOG: f.log,
      NODE_OPTIONS: `--import=${guard}`,
      LANG: "C.UTF-8",
    };
    callback(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function snapshot(root, path = root) {
  return readdirSync(path)
    .filter((name) => path !== root || name !== "backups")
    .flatMap((name) => {
      const file = join(path, name);
      const stat = lstatSync(file);
      const record = [
        relative(root, file),
        stat.mode & 0o7777,
        stat.isSymbolicLink()
          ? readlinkSync(file)
          : stat.isDirectory()
            ? "directory"
            : readFileSync(file).toString("base64"),
      ];
      return stat.isDirectory() ? [record, ...snapshot(root, file)] : [record];
    });
}

function onlyBackup(f, kind) {
  const base = join(f.home, "backups", kind);
  const entries = readdirSync(base);
  assert.equal(entries.length, 1);
  return join(base, entries[0]);
}

function section(f, heading) {
  const doc = readFileSync(join(f.admin, "docs/operations/update-assistant.md"), "utf8");
  const text = doc.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  assert(text !== undefined, `Missing section: ${heading}`);
  return [...text.matchAll(/```sh\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
}

function runSection(f, heading, index) {
  const blocks = section(f, heading);
  assert(blocks.length > 0);
  run(f, "bash", [
    "--noprofile",
    "--norc",
    "-euc",
    index === undefined ? blocks.join("\n") : blocks[index],
  ]);
}

function run(f, command, args, env = {}, success = true) {
  const result = spawnSync(command, args, {
    cwd: f.admin,
    env: { ...f.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (success) assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result;
}

function commandDouble() {
  return `
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
const root = process.env.FIXTURE_ROOT;
assert(root?.includes("deployment-bootstrap-"));
const home = process.env.FIXTURE_HOME;
const log = (text) => fs.appendFileSync(process.env.FIXTURE_LOG, text + "\\n");
const inside = (path) => {
  const absolute = resolve(path);
  assert(absolute.startsWith(root + "/"), "Outside fixture: " + absolute);
  return absolute;
};
const execute = (command, args) => {
  const result = spawnSync(command, args, { env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 98);
};
const name = basename(process.argv[1]);
let args = process.argv.slice(2);
if (name === "sudo") {
  while (args[0]?.startsWith("-")) {
    const flag = args.shift();
    if (flag === "-u") assert.equal(args.shift(), "fixture");
    else assert(["-H", "-i", "--"].includes(flag));
  }
  const command = args.shift();
  if (command.endsWith("/alignfirst-assistant-kill")) {
    inside(command); assert.equal(args.length, 0); log("kill");
  } else {
    assert(["install", "chattr", "chown", "rsync"].includes(command) ||
      [join(root, "opt/fixture/libexec/bootstrap-backup.sh"), join(home, "seed/bin/backup.sh")].includes(command));
    execute(command, args);
  }
} else if (name === "git") {
  assert.deepEqual(args, ["pull"]);
} else if (name === "id") {
  assert.deepEqual(args, ["-un"]); console.log("fixture");
} else if (name === "install") {
  const safe = [];
  while (args[0]?.startsWith("-")) {
    const flag = args.shift();
    if (["-o", "-g"].includes(flag)) assert.equal(args.shift(), "root");
    else if (flag === "-m") safe.push(flag, args.shift());
    else { assert(["-d", "-D"].includes(flag)); safe.push(flag); }
  }
  for (const path of args) inside(path);
  execute("/usr/bin/install", [...safe, ...args]);
} else if (name === "chown") {
  assert.deepEqual(args.slice(0, 2), ["-R", "fixture:fixture"]);
  args.slice(2).forEach(inside);
} else if (name === "chattr") {
  assert(["-i", "+i"].includes(args[0])); log("chattr:" + args.shift());
  args.forEach(inside);
} else if (name === "rsync") {
  assert.deepEqual(args.slice(0, 2), ["-a", "--delete"]);
  assert.equal(args.length, 4);
  const source = inside(args[2]), destination = inside(args[3]);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true }); log("rsync");
} else if (name === "openclaw") {
  assert.equal(args.length, 6);
  assert.deepEqual(args.slice(0, 3), ["backup", "create", "--output"]);
  assert.deepEqual(args.slice(4), ["--no-include-workspace", "--verify"]);
  fs.writeFileSync(join(inside(args[3]), "fixture-openclaw-backup.tar.gz"), "archive double\\n");
  log("openclaw");
} else if (name === "tar") {
  const operation = args.includes("--create") ? "create" : args.includes("--list") ? "list" : "extract";
  log("tar:" + operation);
  if (process.env.FAIL_TAR === operation) process.exit(31);
  for (const flag of ["--file", "--directory"]) {
    const index = args.indexOf(flag);
    assert(index !== -1 || operation === "list");
    if (index !== -1) inside(args[index + 1]);
  }
  execute("/usr/bin/tar", args);
} else throw new Error("Forbidden command: " + name);
`;
}
