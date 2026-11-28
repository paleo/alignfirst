import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installStandIns,
  journalCalls,
  readJournal,
  replayState,
  standInEnv,
} from "./fixtures/deployment-standins.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const source = join(
  repository,
  "skills/aligndev-openclaw-setup/assets/aligndev-openclaw-template/base/infra/openclaw",
);
const outcomes = {
  success: {},
  failure: { FIXTURE_OUTCOME: "failure" },
  signal: { FIXTURE_OUTCOME: "signal" },
  partialUnlock: { STANDIN_FAIL_UNLOCK_ONCE: "1" },
  killFailure: { STANDIN_FAIL_KILL: "after-service" },
  initialKillFailure: { STANDIN_FAIL_KILL: "always" },
};
const privilegedCommands = [
  "chattr",
  "chown",
  "chmod",
  "install",
  "rsync",
  "openclaw",
  "kill-switch",
  "runuser",
  "service-command",
];

// Every privileged command is a fixture stand-in. Node's root check is rewritten only in the
// disposable helper; production scripts expose no environment-controlled bypass.
test("contained package .bin links survive hardening and recovery; unsafe backup links fail first", () => {
  fixture((f) => {
    f.prepare();
    const prefix = join(f.home, ".npm-system-global");
    const npm = join(f.native, "npm");
    for (const root of [prefix, npm]) {
      mkdirSync(join(root, "lib/node_modules/tool"), { recursive: true });
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "lib/node_modules/tool/cli.js"), "#!/usr/bin/env node\n", {
        mode: 0o755,
      });
      symlinkSync("../lib/node_modules/tool/cli.js", join(root, "bin/tool"));
    }
    const link = join(npm, "node_modules/.bin/tool");
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(join(npm, "node_modules/tool"));
    writeFileSync(join(npm, "node_modules/tool/cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(join(npm, "node_modules/tool/cli.js"), link);
    assert.equal(f.call("validate-maintenance").status, 0);
    assert.equal(f.call("harden").status, 0);
    assert(!f.calls().some((call) => call[0] === "chattr" && call.includes(link)));
    const backup = join(f.root, "link-backup");
    assert.equal(f.call("backup", backup).status, 0);
    assert.equal(
      readlinkSync(join(backup, "store-0/npm/node_modules/.bin/tool")),
      "../tool/cli.js",
    );
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readlinkSync(link), "../tool/cli.js");
    assert((statSync(link).mode & 0o100) !== 0);
    const marker = join(f.native, "bin/must-survive-invalid-recovery");
    writeFileSync(marker, "preflight marker\n");
    const savedLink = join(backup, "store-0/npm/node_modules/.bin/tool");
    for (const target of [
      join(f.root, "outside"),
      join(backup, "store-0/npm/node_modules/tool/cli.js"),
    ]) {
      rmSync(savedLink);
      symlinkSync(target, savedLink);
      assert.notEqual(f.call("recover", backup).status, 0, target);
      assert(existsSync(marker), "Unsafe backup links must fail before exact replacement begins");
    }
  });
});

test("backup preserves the physical identity of absolute package links with symlink/.. components", () => {
  fixture((f) => {
    f.prepare();
    const npm = join(f.native, "npm");
    mkdirSync(join(npm, "physical/deep"), { recursive: true });
    mkdirSync(join(npm, "bin"));
    writeFileSync(join(npm, "physical/tool.js"), "physical target\n", { mode: 0o755 });
    writeFileSync(join(npm, "tool.js"), "wrong lexical target\n");
    symlinkSync("physical/deep", join(npm, "alias"));
    symlinkSync(`${npm}/alias/../tool.js`, join(npm, "bin/tool"));
    assert.equal(readFileSync(join(npm, "bin/tool"), "utf8"), "physical target\n");
    const backup = join(f.root, "physical-link-backup");
    const saved = f.call("backup", backup);
    assert.equal(saved.status, 0, saved.stderr);
    const copied = join(backup, "store-0/npm/bin/tool");
    assert.equal(readlinkSync(copied), "../physical/tool.js");
    assert.equal(readFileSync(copied, "utf8"), "physical target\n");
    rmSync(npm, { recursive: true });
    assert.equal(readFileSync(copied, "utf8"), "physical target\n");
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(join(npm, "bin/tool"), "utf8"), "physical target\n");
    assert((statSync(join(npm, "bin/tool")).mode & 0o100) !== 0);
  });
});

test("package links reject escapes, target-chain escapes, cycles, dangling targets and root aliases before mutation", () => {
  fixture((f) => {
    f.prepare();
    const npm = join(f.native, "npm");
    const prefix = join(f.home, ".npm-system-global");
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "tool"), "outside");
    mkdirSync(join(npm, "bin"));
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(npm, "tool"), "contained target\n");
    for (const [index, target] of [
      join(outside, "tool"),
      "../../../outside/tool",
      "../escape/tool",
      "tool",
      "../missing",
      "../escape/../tool",
    ].entries()) {
      const link = join(npm, "bin/tool");
      if (target.includes("escape")) symlinkSync(outside, join(npm, "escape"));
      symlinkSync(target, link);
      const actions =
        index === 0 ? ["validate-maintenance", "unlock", "harden"] : ["validate-maintenance"];
      for (const action of actions)
        assert.notEqual(
          f.call(action, ...(action === "validate-maintenance" ? [] : ["agent-config"])).status,
          0,
          `${action} ${target}`,
        );
      rmSync(link);
      rmSync(join(npm, "escape"), { force: true });
    }
    for (const target of [join(outside, "tool"), "../../../../outside/tool", "tool"]) {
      symlinkSync(target, join(prefix, "bin/tool"));
      assert.notEqual(f.call("validate-maintenance").status, 0, target);
      rmSync(join(prefix, "bin/tool"));
    }
    symlinkSync("../extensions", join(f.native, "skills/alias"));
    assert.notEqual(
      f.call("validate").status,
      0,
      "Non-package trees must still reject contained links",
    );
    rmSync(join(f.native, "skills/alias"));
    rmSync(npm, { recursive: true });
    symlinkSync(prefix, npm);
    assert.notEqual(f.call("validate").status, 0, "A package anchor itself cannot be an alias");
    assert.deepEqual(f.privileged(), []);
  });
});

test("package restoration rejects a link escape introduced during the service command before recursive repair", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    const prefix = join(f.home, ".npm-system-global");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    const target = join(f.root, "outside-executable");
    writeFileSync(target, "outside\n", { mode: 0o755 });
    const result = f.run(["packages"], {
      FIXTURE_MUTATION: JSON.stringify({ packageLink: target }),
    });
    assert.equal(result.status, 1, result.stderr);
    const calls = f.calls();
    const kill = calls.findLastIndex((call) => call[0] === "kill-switch");
    assert.equal(
      calls
        .slice(kill + 1)
        .filter((call) => call[0] === "chown" || call[0] === "chmod" || call[0] === "chattr")
        .length,
      0,
      "Unsafe packages must fail before recursive repair",
    );
    assert.equal(readFileSync(target, "utf8"), "outside\n");
  });
});

test("instruction sentinels preserve an existing alternate instruction winner", () => {
  for (const name of ["CLAUDE.MD", "AGENTS.override.md"]) {
    fixture((f) => {
      mkdirSync(f.native, { recursive: true });
      writeFileSync(join(f.native, name), "Existing operator instructions\n");
      assert.equal(f.inventory().instructionFile, join(f.native, name));
      f.prepare();
      assert.equal(f.inventory().instructionFile, join(f.native, name));
      assert.equal(readFileSync(join(f.native, name), "utf8"), "Existing operator instructions\n");
      assert(statSync(join(f.native, "AGENTS.md")).isDirectory());
    });
  }
});

test("hardening reserves real discovery names, protects sticky anchors and preserves executables/auth", () => {
  fixture((f) => {
    f.prepare();
    writeFileSync(join(f.native, "auth.json"), '{"fixture":{"type":"api_key","key":"fake"}}');
    writeFileSync(join(f.native, "npm/tool"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(f.native, "bin/native-tool"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(f.native, "agents/reviewer.md"), "Existing user profile\n");
    assert.equal(f.call("harden").status, 0);
    const state = f.state();
    const inventory = f.inventory();
    for (const anchor of [f.home, ...inventory.stores.map((store) => store.configDir)])
      assert.deepEqual(state[anchor], { owner: "root", mode: 0o1770, immutable: false }, anchor);
    for (const resource of inventory.resources)
      assert.equal(state[resource.path]?.immutable, true, resource.path);
    assert.deepEqual(state[join(f.native, "npm/tool")], {
      owner: "root",
      mode: 0o755,
      immutable: true,
    });
    assert.equal(state[join(f.native, "bin/native-tool")].immutable, true);
    assert.deepEqual(state[join(f.native, "auth.json")], {
      owner: "service",
      mode: 0o600,
      immutable: false,
    });
    assert.equal(
      readFileSync(join(f.native, "agents/reviewer.md"), "utf8"),
      "Existing user profile\n",
    );
    assert(statSync(join(f.native, "AGENTS.override.md")).isDirectory());
    assert.equal(readFileSync(join(f.native, "SYSTEM.md"), "utf8"), "");
  });
});

test("maintenance restores protected scopes but leaves AlignFirst writable after every outcome", () => {
  for (const [outcome, status] of [
    ["success", 0],
    ["signal", 143],
    ["partialUnlock", 1],
  ]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const openclawConfig = join(f.home, ".openclaw/openclaw.json");
      mkdirSync(dirname(openclawConfig), { recursive: true });
      writeFileSync(openclawConfig, "{}\n");
      const result = f.run(
        ["config", "instructions", "agent-config", "agent-skills"],
        outcomes[outcome],
      );
      assert.equal(result.status, status, `${outcome}\n${result.stderr}`);
      const calls = f.calls();
      const unlock = calls.findIndex((call) => call[0] === "chattr" && call[1] === "-i");
      const kill = calls.flatMap((call, index) => (call[0] === "kill-switch" ? [index] : []));
      assert.equal(kill.length, 2);
      assert(kill[0] < unlock);
      const alignfirstHome = dirname(f.deployed);
      assert(
        !calls.some(
          (call) =>
            ["chown", "chmod", "chattr"].includes(call[0]) &&
            call
              .slice(2)
              .some((path) => path === alignfirstHome || path.startsWith(`${alignfirstHome}/`)),
        ),
        "maintenance must not change ownership, modes or attributes under ~/.alignfirst",
      );
      assert(f.immutable().includes(openclawConfig), "OpenClaw configuration stays protected");
      assert(
        calls.some((call, index) => index > kill[1] && call[0] === "chattr" && call[1] === "+i"),
      );
      assert.equal(
        calls.some((call) => call[0] === "service-command"),
        outcome !== "partialUnlock",
      );
    });
  }
});

test("combined shared/native skills maintenance thaws hardened descendants before ownership repair", () => {
  for (const [scopes, windows] of [
    [["skills", "agent-skills"], 2],
    [["agent-skills", "skills"], 1],
  ]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const shared = join(f.home, ".agents/skills/nested/SKILL.md");
      mkdirSync(dirname(shared), { recursive: true });
      writeFileSync(shared, "shared skill\n");
      const harden = f.call("harden");
      assert.equal(harden.status, 0, harden.stderr);
      assert(f.immutable().includes(shared));
      for (let window = 0; window < windows; ++window) {
        const result = f.run(scopes);
        assert.equal(result.status, 0, result.stderr);
        assert(f.immutable().includes(shared), "Shared descendants must be re-hardened");
        assert(f.immutable().includes(join(f.native, "skills")));
      }
    });
  }
});

test("native recovery alone tolerates missing declared npm contents and snapshots before controlled restore", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    const installed = join(f.native, "npm/node_modules/fixture-tool");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "tool.js"), "restored package\n", { mode: 0o755 });
    writeFileSync(
      join(f.native, "settings.json"),
      JSON.stringify({ packages: ["npm:fixture-tool@1.0.0"] }),
    );
    const backup = join(f.root, "npm-recovery-backup");
    assert.equal(f.call("backup", backup).status, 0);
    rmSync(installed, { recursive: true });
    assert.notEqual(f.call("validate").status, 0, "Normal policy actions stay strict");
    assert.notEqual(f.run(["agent-config"]).status, 0, "Normal maintenance stays strict");
    assert.deepEqual(f.privileged(), [], "Normal maintenance must refuse before containment");
    const result = f.recover(backup);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(installed, "tool.js"), "utf8"), "restored package\n");
    const snapshots = f.snapshots();
    assert(snapshots.length > 0);
    assert(snapshots.every((snapshot) => snapshot.snapshotVersion === 1));
    assert(
      snapshots.some((snapshot) =>
        snapshot.resources.some((item) => item.path === join(f.native, "npm")),
      ),
    );
    assert(f.immutable().includes(join(installed, "tool.js")));
    assert.equal(f.calls().filter((call) => call[0] === "kill-switch").length, 2);
    const copy = f
      .calls()
      .find((call) => call[0] === "install" && call.at(-1).endsWith("/settings.json"));
    assert.deepEqual(
      copy?.slice(0, -1),
      ["install", "-m", "644", "-o", "root", "-g", "root", f.settingsFile],
      "Recovery reads a root-owned copy of the reviewed settings",
    );
    assert(
      !existsSync(dirname(copy.at(-1))),
      "The readable settings copy is removed after recovery",
    );
  });
});

test("native recovery keeps unsafe package refusals before containment", () => {
  for (const variant of ["package-link", "package-file"])
    fixture((f) => {
      f.prepare();
      f.install();
      const installed = join(f.native, "npm/node_modules/fixture-tool");
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(
        join(f.native, "settings.json"),
        JSON.stringify({ packages: ["npm:fixture-tool"] }),
      );
      if (variant === "package-link") symlinkSync(f.root, installed);
      else writeFileSync(installed, "not a directory\n");
      const result = f.recover(join(f.root, "not-used"));
      assert.notEqual(result.status, 0, result.stderr);
      assert.deepEqual(f.privileged(), [], variant);
    });
});

test("native recovery refuses malformed invocation and invalid backup before destructive replacement", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    const marker = join(f.native, "bin/preflight-marker");
    writeFileSync(marker, "keep on failure\n");
    const installed = join(f.native, "npm/node_modules/fixture-tool");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(f.native, "settings.json"),
      JSON.stringify({ packages: ["npm:fixture-tool"] }),
    );
    const backup = join(f.root, "invalid-recovery");
    assert.equal(f.call("backup", backup).status, 0);
    rmSync(installed, { recursive: true });
    const mapping = JSON.parse(readFileSync(join(backup, "mapping.json"), "utf8"));
    mapping.stores[0].destination = join(f.root, "escape");
    writeFileSync(join(backup, "mapping.json"), JSON.stringify(mapping));
    for (const args of [
      ["native-recovery", "--"],
      ["native-recovery", "config", "--", backup],
      ["native-recovery", "--", backup, "extra"],
      ["agent-config", "native-recovery", "--", backup],
    ]) {
      const result = spawnSync("bash", [f.wrapper, ...args], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr);
    }
    assert.deepEqual(f.privileged(), []);
    const result = f.recover(backup);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(marker, "utf8"), "keep on failure\n");
    assert(f.immutable().includes(marker));
    assert.equal(f.calls().filter((call) => call[0] === "kill-switch").length, 2);
    const retained = result.stderr.match(/inventory: (\S+)/u)?.[1];
    assert(retained?.startsWith(`${f.root}/`), result.stderr);
    const snapshot = join(retained, "0.json");
    assert.equal(statSync(retained).mode & 0o077, 0);
    assert.equal(statSync(snapshot).mode & 0o077, 0);
    assert(
      JSON.parse(readFileSync(snapshot, "utf8")).resources.some(
        (item) => item.path === join(f.native, "npm"),
      ),
    );
  });
});

test("native recovery preflight rejects unrooted backup resources and unsafe sources", () => {
  for (const variant of ["destination", "declaration", "source-link", "overlap"])
    fixture((f) => {
      f.prepare();
      const external = join(f.home, "reviewed-extension.ts");
      writeFileSync(external, "reviewed external content\n");
      writeFileSync(join(f.native, "settings.json"), JSON.stringify({ extensions: [external] }));
      const backup = join(f.home, "reviewed-backup");
      assert.equal(f.call("backup", backup).status, 0);
      rmSync(join(f.native, "settings.json"));
      const valid = f.call("snapshot-backup", backup, join(f.root, "valid.json"));
      assert.equal(valid.status, 0, valid.stderr);
      const manifestPath = join(backup, "mapping.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (variant === "destination" || variant === "overlap") {
        manifest.resources[0].destination =
          variant === "destination" ? join(f.home, "unreviewed.ts") : backup;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      if (variant === "declaration" || variant === "overlap")
        writeFileSync(
          join(backup, "store-0/settings.json"),
          JSON.stringify({
            extensions: [variant === "declaration" ? "/outside-fixture" : backup],
          }),
        );
      if (variant === "source-link") {
        rmSync(join(backup, "resource-0"));
        symlinkSync(external, join(backup, "resource-0"));
      }
      const snapshot = join(f.root, "rejected.json");
      assert.notEqual(f.call("snapshot-backup", backup, snapshot).status, 0, variant);
      assert(!existsSync(snapshot), variant);
    });
});

test("native recovery unlocks resources declared only in the backup and restores their policy after a failure", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    const external = join(f.home, "reviewed-extension.ts");
    const skills = join(f.home, "reviewed-skills");
    writeFileSync(external, "reviewed external extension\n");
    mkdirSync(skills);
    writeFileSync(join(skills, "SKILL.md"), "reviewed skill\n");
    writeFileSync(
      join(f.native, "settings.json"),
      JSON.stringify({ extensions: [external], skills: [skills] }),
    );
    assert.equal(f.call("harden").status, 0);
    const backup = join(f.root, "lost-declarations-backup");
    assert.equal(f.call("backup", backup).status, 0);
    rmSync(join(f.native, "settings.json"));
    const start = f.calls().length;
    const result = f.recover(backup, {
      FIXTURE_MUTATION: JSON.stringify({ failRecovery: true }),
    });
    assert.equal(result.status, 1, result.stderr);
    const calls = f.calls().slice(start);
    const service = calls.findIndex(([name]) => name === "service-command");
    const state = f.state();
    for (const path of [external, join(skills, "SKILL.md")]) {
      assert(
        calls
          .slice(0, service)
          .some(([name, flag, target]) => name === "chattr" && flag === "-i" && target === path),
        `Backup-derived resource must be unlocked before service recovery: ${path}`,
      );
      assert.equal(state[path].owner, "root", path);
      assert.equal(state[path].immutable, true, path);
    }
  });
});

test("failed recontainment aborts all privileged cleanup", () => {
  for (const [outcome, kills] of [
    ["killFailure", 2],
    ["initialKillFailure", 1],
  ]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const result = f.run(["agent-config"], outcomes[outcome]);
      assert.equal(result.status, 1, result.stderr);
      const calls = f.privileged();
      const killIndexes = calls.flatMap((call, index) =>
        call[0] === "kill-switch" ? [index] : [],
      );
      assert.equal(killIndexes.length, kills);
      assert.deepEqual(
        calls.slice(killIndexes.at(-1) + 1),
        [],
        "No thaw/chown/chmod after failed containment",
      );
    });
  }
});

test("private resolved inventory restores removed declarations and protects newly declared resources", () => {
  for (const [variant, outcome, status] of [
    ["remove", "success", 0],
    ["change-failure", "failure", 42],
    ["invalid-settings", "success", 1],
  ]) {
    fixture((f) => {
      f.prepare();
      const original = join(f.home, "original-package");
      const added = join(f.home, "new-skills");
      mkdirSync(original);
      mkdirSync(added);
      writeFileSync(join(original, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(added, "SKILL.md"), "new resource\n");
      writeFileSync(join(f.native, "settings.json"), JSON.stringify({ packages: [original] }));
      f.install();
      const mutation = {
        remove: variant === "remove",
        malformed: variant === "invalid-settings",
        settings: { skills: [added] },
      };
      const result = f.run(["agent-config"], {
        ...outcomes[outcome],
        FIXTURE_MUTATION: JSON.stringify(mutation),
      });
      assert.equal(result.status, status, `${variant}\n${result.stderr}`);
      const calls = f.calls();
      const lastKill = calls.findLastIndex((call) => call[0] === "kill-switch");
      assert(
        calls.some(
          (call, index) =>
            index < lastKill &&
            call[0] === "chown" &&
            call[1] === "fixture:fixture" &&
            call[2] === original,
        ),
        "The original external resource was unlocked",
      );
      for (const path of [original, join(original, "tool")]) {
        assert(
          calls.some(
            (call, index) =>
              index > lastKill && call[0] === "chattr" && call[1] === "+i" && call[2] === path,
          ),
          `Original resource must be repaired: ${path}`,
        );
      }
      assert(
        f
          .snapshots()
          .some((snapshot) => snapshot.resources.some((resource) => resource.path === original)),
        "Snapshot records resolved resources, not just deployment settings",
      );
      if (variant === "change-failure") {
        assert(
          calls.some(
            (call, index) =>
              index > lastKill &&
              call[0] === "chattr" &&
              call[1] === "+i" &&
              call[2] === join(added, "SKILL.md"),
          ),
          "New resources outside the opened scope must also be protected",
        );
      }
    });
  }
});

test("root wrapper and backup use installed policy helpers even when checkout and seed helpers are hostile", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    for (const name of ["deployment-policy.mjs", "deployment-profiles.mjs"]) {
      writeFileSync(join(f.infra, name), "throw new Error('MUTABLE CHECKOUT EXECUTED');\n");
      mkdirSync(join(f.home, "seed"), { recursive: true });
      writeFileSync(join(f.home, "seed", name), "throw new Error('SERVICE SEED EXECUTED');\n");
    }
    const result = f.run(["agent-config"]);
    assert.equal(result.status, 0, result.stderr);
    mkdirSync(join(f.home, ".openclaw/workspace"), { recursive: true });
    const backup = spawnSync("bash", [join(f.infra, "bin/backup.sh")], {
      env: f.env,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(backup.status, 0, backup.stderr);
    assert(
      existsSync(join(backup.stdout.trim(), "native/mapping.json")),
      "Backup must execute the installed helper",
    );
  });
});

test("maintenance refuses symlinked fixed ownership roots before containment or recursive operations", () => {
  fixture((f) => {
    f.prepare();
    f.install();
    symlinkSync(join(f.root, "outside"), join(f.home, ".npm-system-global"));
    const result = f.run(["packages"]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.privileged(), []);
  });
});

test("private backup/recovery maps custom stores, sessions, credentials and executable modes", () => {
  fixture((f) => {
    f.prepare();
    mkdirSync(join(f.native, "sessions/project"), { recursive: true });
    writeFileSync(join(f.native, "sessions/project/conversation.jsonl"), "private transcript\n");
    writeFileSync(join(f.native, "auth.json"), "fake private credential\n");
    writeFileSync(join(f.home, "custom-pi/trust.json"), '{"fixture":true}');
    writeFileSync(join(f.native, "npm/tool"), "#!/bin/sh\n", { mode: 0o755 });
    const localPackage = join(f.home, "managed-local-package");
    mkdirSync(localPackage);
    writeFileSync(join(localPackage, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(f.native, "settings.json"),
      JSON.stringify({ packages: ["~/managed-local-package"] }),
    );
    const backup = join(f.root, "private-backup");
    assert.equal(f.call("backup", backup).status, 0);
    for (const path of walk(backup)) assert.equal(statSync(path).mode & 0o077, 0, path);
    const mapping = JSON.parse(readFileSync(join(backup, "mapping.json"), "utf8"));
    assert.equal(mapping.stores[2].destination, join(f.home, "custom-pi"));
    assert.equal(
      readFileSync(join(backup, "store-0/auth.json"), "utf8"),
      "fake private credential\n",
    );
    rmSync(f.native, { recursive: true });
    rmSync(localPackage, { recursive: true });
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert((statSync(join(localPackage, "tool")).mode & 0o100) !== 0);
    assert.equal(
      readFileSync(join(f.native, "sessions/project/conversation.jsonl"), "utf8"),
      "private transcript\n",
    );
    assert((statSync(join(f.native, "npm/tool")).mode & 0o100) !== 0);
  });
});

test("recovery replaces contents exactly rather than retaining post-backup executable resources", () => {
  fixture((f) => {
    f.prepare();
    const local = join(f.home, "recovery-package");
    mkdirSync(local);
    writeFileSync(join(local, "original"), "original\n", { mode: 0o755 });
    writeFileSync(join(f.native, "settings.json"), JSON.stringify({ packages: [local] }));
    const overlapping = join(local, "unsafe-backup");
    const overlap = f.call("backup", overlapping);
    assert.notEqual(overlap.status, 0);
    assert(
      !existsSync(overlapping),
      "Reject overlapping external resources before creating a backup",
    );
    const backup = join(f.root, "exact-backup");
    assert.equal(f.call("backup", backup).status, 0);
    const extras = [
      ...["extensions", "npm", "agents", "bin"].map((name) =>
        join(f.native, name, "post-backup.js"),
      ),
      join(f.home, "custom-pi/extensions/post-backup.js"),
      join(local, "post-backup.js"),
    ];
    for (const path of extras)
      writeFileSync(path, "throw new Error('post-backup execution');\n", { mode: 0o755 });
    writeFileSync(join(local, "original"), "modified\n");
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    for (const path of extras) assert(!existsSync(path), path);
    assert.equal(readFileSync(join(local, "original"), "utf8"), "original\n");
    assert((statSync(join(local, "original")).mode & 0o100) !== 0);
  });
});

test("recovery removes executable state from stores absent at backup time", () => {
  fixture((f) => {
    const backup = join(f.root, "absent-backup");
    assert.equal(f.call("backup", backup).status, 0);
    f.prepare();
    const extra = join(f.native, "bin/new-tool");
    writeFileSync(extra, "#!/bin/sh\n", { mode: 0o755 });
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert(!existsSync(extra));
    assert.deepEqual(readdirSync(f.native), []);
  });
});

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "deployment-core-"));
  const home = join(root, "home");
  const infra = join(root, "admin/infra/openclaw");
  const bin = join(root, "doubles");
  const settingsFile = join(infra, "aligndev.settings.json");
  const deployed = join(home, ".alignfirst/aligndev.settings.json");
  const journal = join(root, "journal");
  const f = {
    root,
    home,
    infra,
    libexec: join(root, "opt/fixture/libexec"),
    settingsFile,
    deployed,
    native: join(home, ".pi/agent"),
    wrapper: join(infra, "bin/assistant-maintenance.sh"),
  };
  f.env = {
    ...standInEnv({ root, home, bin, journal }),
    HOME: home,
    USER: "fixture",
    LOGNAME: "fixture",
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: root,
    PI_OFFLINE: "1",
  };
  try {
    mkdirSync(home);
    mkdirSync(bin);
    cpSync(source, infra, { recursive: true });
    for (const path of walk(infra).filter((path) => statSync(path).isFile())) {
      let text = readFileSync(path, "utf8")
        .replaceAll("{{SERVICE_USER}}", "fixture")
        .replaceAll("{{SERVER_ADMIN_USER}}", "operator")
        .replaceAll("{{ADMIN_REPOSITORY_NAME}}", "admin");
      text = text
        .replaceAll("/usr/bin/node", process.execPath)
        .replaceAll("/home/fixture", home)
        .replaceAll("/home/operator/admin", join(root, "admin"))
        .replaceAll("/usr/local/sbin/alignfirst-assistant-kill", join(root, "kill-switch"))
        .replaceAll("/opt/fixture/libexec", f.libexec);
      if (path.endsWith("deployment-policy.mjs"))
        text = text.replace("process.getuid() !== 0", "false");
      writeFileSync(path, text);
    }
    mkdirSync(f.libexec, { recursive: true });
    for (const name of ["deployment-policy.mjs", "deployment-profiles.mjs"])
      cpSync(join(infra, name), join(f.libexec, name));
    f.settings = {
      code: {
        profiles: {
          openclaw: { harness: "openclaw", defaultAgentProfile: "main" },
          main: {
            harness: "pi",
            configDir: "~/.pi/agent",
            quota: { source: "codex", configDir: "~/.codex-quota" },
          },
          shared: { harness: "pi", configDir: "~/.pi/agent" },
          custom: { harness: "pi", default: true, configDir: "~/custom-pi" },
          claude: { harness: "claude", default: true, configDir: "~/.claude" },
        },
      },
    };
    writeFileSync(settingsFile, JSON.stringify(f.settings));
    f.call = (action, ...args) =>
      spawnSync(
        process.execPath,
        [join(infra, "deployment-policy.mjs"), action, settingsFile, home, deployed, ...args],
        { env: f.env, encoding: "utf8", timeout: 20_000 },
      );
    f.inventory = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [join(infra, "deployment-profiles.mjs"), settingsFile, home, deployed],
          { env: f.env, encoding: "utf8" },
        ),
      );
    f.prepare = () => {
      const result = f.call("prepare");
      assert.equal(result.status, 0, result.stderr);
    };
    f.install = () => {
      mkdirSync(dirname(deployed), { recursive: true });
      cpSync(settingsFile, deployed);
    };
    const wrapper = (args, env = {}) =>
      spawnSync("bash", [f.wrapper, ...args], {
        env: { ...f.env, ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
    f.run = (scopes, env) => wrapper([...scopes, "--", join(root, "service-command")], env);
    f.recover = (backup, env) => wrapper(["native-recovery", "--", backup], env);
    f.calls = () => journalCalls(readJournal(journal));
    f.privileged = () => f.calls().filter(([name]) => privilegedCommands.includes(name));
    f.state = () => replayState(readJournal(journal));
    f.immutable = () =>
      Object.entries(f.state())
        .filter(([, entry]) => entry.immutable)
        .map(([path]) => path);
    f.snapshots = () =>
      readJournal(journal)
        .filter(([kind]) => kind === "snapshot")
        .map(([, json]) => JSON.parse(json));
    writeFileSync(journal, "");
    installStandIns(bin, [
      "id",
      "chown",
      "chmod",
      "chattr",
      ["install", "install.mjs"],
      "rsync",
      ["runuser", "maintenance-runuser.mjs"],
      "openclaw",
    ]);
    installStandIns(root, ["kill-switch"]);
    writeFileSync(join(root, "service-command"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    callback(f);
    assertPrivilegedShapes(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The stand-ins accept every argument shape; the shapes the wrapper and helpers may use are
// asserted here, after each test.
function assertPrivilegedShapes(f) {
  const home = f.home;
  const backups = join(home, "backups/deployment");
  const recursiveTargets = {
    chown: [
      join(home, "seed"),
      join(home, ".npm-system-global"),
      join(home, ".agents"),
      join(home, ".openclaw/skills"),
    ],
    chmod: [join(home, ".npm-system-global")],
  };
  for (const [name, ...args] of f.calls()) {
    const recursive = ["-R", "-Rh"].includes(args[0]);
    const [value, ...paths] = recursive ? args.slice(1) : args;
    const shape = `${name} ${args.join(" ")}`;
    if (name === "chown")
      assert(
        ["fixture:fixture", "root:fixture", "root:root", "operator:operator"].includes(value),
        shape,
      );
    if (name === "chmod")
      assert(
        (recursive ? ["go-w", "go-rwx"] : ["600", "640", "644", "700", "755", "1770"]).includes(
          value,
        ),
        shape,
      );
    if (recursive)
      assert(
        paths.length === 1 &&
          (recursiveTargets[name]?.includes(paths[0]) ||
            (name === "chmod" && value === "go-rwx" && paths[0].startsWith(`${backups}/`))),
        shape,
      );
    if (name === "install")
      assert(
        (args.length === 8 &&
          args.slice(0, 7).join(" ") === `-m 644 -o root -g root ${f.settingsFile}`) ||
          (args.length === 4 &&
            args.slice(0, 3).join(" ") === "-d -m 700" &&
            args[3] === backups) ||
          (args.length === 5 &&
            args.slice(0, 2).join(" ") === "-D -m" &&
            args[2] === "600" &&
            args[3].startsWith(`${home}/`) &&
            args[4].startsWith(`${backups}/`)),
        shape,
      );
  }
}

function walk(path) {
  if (!existsSync(path)) return [];
  return [
    path,
    ...(lstatSync(path).isDirectory()
      ? readdirSync(path).flatMap((name) => walk(join(path, name)))
      : []),
  ];
}
