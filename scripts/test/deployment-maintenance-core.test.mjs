import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const source = join(
  repository,
  "skills/alignfirst-setup-guide/assets/aligndev-openclaw-template/base/infra/openclaw",
);

// Every privileged command is a fixture-owned rejecting double. Node's root check is rewritten
// only in the disposable helper; production scripts expose no environment-controlled bypass.
test("core inventory includes every coding/quota store and resolves deployed relative paths", () => {
  fixture((f) => {
    const inventory = f.inventory();
    assert.equal(inventory.agent, "pi");
    assert.equal(inventory.profiles.length, 4);
    assert.deepEqual(
      inventory.stores.map((store) => store.configDir),
      [f.native, join(f.home, ".codex-quota"), join(f.home, "custom-pi"), join(f.home, ".claude")],
    );
    assert.equal(inventory.stores[0].profiles.length, 2);
    assert(
      inventory.resources.some(
        (resource) => resource.path === join(f.native, "AGENTS.override.md"),
      ),
    );
    assert(inventory.resources.some((resource) => resource.path === join(f.native, "agents")));
    assert(inventory.resources.some((resource) => resource.path === join(f.native, "bin")));
    assert(
      inventory.resources.some((resource) => resource.path === join(f.home, "AGENTS.override.md")),
    );
    assert(!inventory.resources.some((resource) => resource.path === join(f.native, "auth.json")));
    f.settings.code.profiles.custom.configDir = "../custom-pi";
    f.save();
    assert.equal(f.inventory().stores[2].configDir, join(f.home, "custom-pi"));
  });
});

test("core refuses symlinks, hardlinks, overlaps, ambiguous environment and discovery globs", () => {
  fixture((f) => {
    const original = structuredClone(f.settings);
    for (const profile of [
      { agent: "pi", configDir: "~/.pi/agent/nested" },
      { agent: "codex", configDir: "~/.pi/agent" },
      { agent: "pi", configDir: "~/projects" },
      { agent: "pi", configDir: "/tmp/external-store" },
      { agent: "pi", configDir: "~/.pi/agent", env: { PI_CODING_AGENT_DIR: "elsewhere" } },
      { agent: "pi", configDir: "~/.pi/agent", env: { HOME: "/elsewhere" } },
      { agent: "pi", configDir: "~/.pi/agent", quota: { source: "codex" } },
      { agent: "pi", configDir: " ~/.pi/agent " },
      { agent: "pi", configDir: pathToFileURL(f.native).href },
    ]) {
      f.settings.code.profiles.bad = profile;
      f.save();
      assert.notEqual(f.call("validate").status, 0);
    }
    f.settings = original;
    f.save();
    mkdirSync(dirname(f.native), { recursive: true });
    symlinkSync(join(f.root, "elsewhere"), f.native);
    assert.notEqual(f.call("validate").status, 0);
    rmSync(f.native);
    mkdirSync(join(f.native, "extensions"), { recursive: true });
    symlinkSync(join(f.root, "elsewhere"), join(f.native, "extensions/escape"));
    assert.notEqual(f.call("validate").status, 0);
    rmSync(join(f.native, "extensions/escape"));
    writeFileSync(join(f.native, "settings.json"), JSON.stringify({ extensions: ["../*.js"] }));
    assert.notEqual(f.call("validate").status, 0);
    writeFileSync(join(f.native, "settings.json"), "{}");
    linkSync(join(f.native, "settings.json"), join(f.native, "models.json"));
    assert.notEqual(f.call("validate").status, 0);
    rmSync(join(f.native, "models.json"));
    writeFileSync(
      join(f.native, "extensions/package.json"),
      JSON.stringify({ pi: { extensions: ["../../outside.js"] } }),
    );
    assert.notEqual(f.call("validate").status, 0);
    assert(!existsSync(f.log), "validation must not call privileged commands");
  });
});

test("contained npm prefix bin and native package .bin links survive validation, hardening and recovery", () => {
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
    mkdirSync(join(npm, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(npm, "node_modules/tool"));
    writeFileSync(join(npm, "node_modules/tool/cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(join(npm, "node_modules/tool/cli.js"), join(npm, "node_modules/.bin/tool"));
    assert.equal(f.call("validate-maintenance").status, 0);
    assert.equal(f.call("harden").status, 0);
    assert(
      !f
        .calls()
        .some((call) => call[0] === "chattr" && call[2] === join(npm, "node_modules/.bin/tool")),
    );
    const backup = join(f.root, "link-backup");
    assert.equal(f.call("backup", backup).status, 0);
    assert.equal(
      readlinkSync(join(backup, "store-0/npm/node_modules/.bin/tool")),
      "../tool/cli.js",
    );
    const recovered = f.call("recover", backup);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readlinkSync(join(npm, "node_modules/.bin/tool")), "../tool/cli.js");
    assert((statSync(join(npm, "node_modules/.bin/tool")).mode & 0o100) !== 0);
    f.install();
    const result = f.run(["packages"]);
    assert.equal(result.status, 0, result.stderr);
    assert(
      f.calls().some((call) => call[0] === "chattr" && call[1] === "+i" && call[2] === prefix),
    );
    const marker = join(f.native, "bin/must-survive-invalid-recovery");
    writeFileSync(marker, "preflight marker\n");
    const savedLink = join(backup, "store-0/npm/node_modules/.bin/tool");
    rmSync(savedLink);
    symlinkSync(join(f.root, "outside"), savedLink);
    assert.notEqual(f.call("recover", backup).status, 0);
    assert(existsSync(marker), "Unsafe backup links must fail before exact replacement begins");
    rmSync(savedLink);
    symlinkSync(join(backup, "store-0/npm/node_modules/tool/cli.js"), savedLink);
    const absoluteBackupLink = f.call("recover", backup);
    assert.notEqual(absoluteBackupLink.status, 0);
    assert(absoluteBackupLink.stderr.includes("Backup package links must be relative"));
    assert(
      existsSync(marker),
      "Even a contained absolute backup link would escape after relocation",
    );
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
    for (const target of [
      join(outside, "tool"),
      "../../../outside/tool",
      "../escape/tool",
      "tool",
      "../missing",
      "../escape/../tool",
    ]) {
      const link = join(npm, "bin/tool");
      if (target.includes("escape")) symlinkSync(outside, join(npm, "escape"));
      symlinkSync(target, link);
      for (const action of ["validate-maintenance", "unlock", "harden"])
        assert.notEqual(
          f.call(action, action === "validate-maintenance" ? undefined : "agent-config").status,
          0,
          target,
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
    assert.equal(f.calls().length, 0);
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
    assert(result.stderr.includes("Package link escapes managed root"));
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

test("native loader accepts padded/file URL resources that deployment rejects before all mutations", () => {
  fixture((f) => {
    mkdirSync(f.native, { recursive: true });
    const extension = join(f.home, "operator-extension.mjs");
    writeFileSync(extension, "export default function () {}\n");
    const probe = join(f.root, "native-paths.mjs");
    const moduleRoot = join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/core");
    writeFileSync(
      probe,
      `
      import { SettingsManager } from ${JSON.stringify(join(moduleRoot, "settings-manager.js"))};
      import { DefaultResourceLoader } from ${JSON.stringify(join(moduleRoot, "resource-loader.js"))};
      const settingsManager = SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR);
      const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true });
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
      console.log(JSON.stringify(loader.getExtensions().extensions.map(item => item.resolvedPath)));
    `,
    );
    for (const declaration of ["  ../../operator-extension.mjs  ", pathToFileURL(extension).href]) {
      writeFileSync(join(f.native, "settings.json"), JSON.stringify({ extensions: [declaration] }));
      const native = spawnSync(process.execPath, [probe], {
        cwd: f.home,
        env: { ...f.env, PI_CODING_AGENT_DIR: f.native, PI_SKIP_VERSION_CHECK: "1" },
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(native.status, 0, native.stderr);
      assert(JSON.parse(native.stdout).includes(extension), declaration);
      for (const action of ["prepare", "unlock", "harden", "snapshot", "backup"])
        assert.notEqual(f.call(action, join(f.root, "must-not-create")).status, 0, action);
      assert(!existsSync(join(f.root, "must-not-create")));
      assert(!existsSync(join(f.native, "models.json")), "Refusal must precede prepare");
      f.install();
      assert.notEqual(f.run(["agent-config"]).status, 0);
      assert.equal(
        f.calls().length,
        0,
        "Refusal must precede containment and privileged operations",
      );
    }
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
    const calls = f.calls();
    for (const store of f.inventory().stores) {
      assert(
        calls.some(
          (call) => call[0] === "chmod" && call[1] === "1770" && call[2] === store.configDir,
        ),
      );
      assert(
        !calls.some(
          (call) => call[0] === "chattr" && call[1] === "+i" && call[2] === store.configDir,
        ),
      );
    }
    assert(calls.some((call) => call[0] === "chmod" && call[1] === "1770" && call[2] === f.home));
    assert(
      calls.some(
        (call) =>
          call[0] === "chmod" && call[1] === "755" && call[2] === join(f.native, "npm/tool"),
      ),
    );
    assert(
      calls.some(
        (call) =>
          call[0] === "chattr" && call[1] === "+i" && call[2] === join(f.native, "bin/native-tool"),
      ),
    );
    assert(!calls.some((call) => call[0] === "chattr" && call[2] === join(f.native, "auth.json")));
    assert.equal(
      readFileSync(join(f.native, "agents/reviewer.md"), "utf8"),
      "Existing user profile\n",
    );
    assert(statSync(join(f.native, "AGENTS.override.md")).isDirectory());
    assert.equal(readFileSync(join(f.native, "SYSTEM.md"), "utf8"), "");
    for (const resource of f.inventory().resources)
      assert(
        calls.some((call) => call[0] === "chattr" && call[1] === "+i" && call[2] === resource.path),
        resource.path,
      );
  });
});

test("maintenance contains before unlock and restores in reverse after success, failure and TERM", () => {
  for (const outcome of ["success", "failure", "signal", "partial-unlock"]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const result = spawnSync(
        "bash",
        [
          f.wrapper,
          "instructions",
          "agent-config",
          "agent-skills",
          "--",
          join(f.root, "service-command"),
        ],
        {
          env: { ...f.env, FIXTURE_OUTCOME: outcome },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.equal(
        result.status,
        outcome === "success" ? 0 : outcome === "failure" ? 42 : outcome === "signal" ? 143 : 1,
        result.stderr,
      );
      const calls = f.calls();
      const unlock = calls.findIndex((call) => call[0] === "chattr" && call[1] === "-i");
      const kill = calls
        .map((call, index) => (call[0] === "kill-switch" ? index : -1))
        .filter((index) => index >= 0);
      assert.equal(kill.length, 2);
      assert(kill[0] < unlock);
      assert(
        calls.some((call, index) => index > kill[1] && call[0] === "chattr" && call[1] === "+i"),
      );
      assert(
        result.stdout.indexOf("restoring agent-skills") <
          result.stdout.indexOf("restoring agent-config"),
      );
      assert(
        result.stdout.indexOf("restoring agent-config") <
          result.stdout.indexOf("restoring instructions"),
      );
      assert.equal(
        calls.some((call) => call[0] === "service-command"),
        outcome !== "partial-unlock",
      );
      assert(!calls.some((call) => call[0] === "systemctl"));
      assert(
        result.stdout.includes("gateway remains stopped") ||
          result.stderr.includes("gateway remains stopped"),
      );
    });
  }
});

test("combined shared/native skills maintenance thaws hardened descendants before ownership repair", () => {
  for (const scopes of [["skills"], ["skills", "agent-skills"], ["agent-skills", "skills"]]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const shared = join(f.home, ".agents/skills/nested/SKILL.md");
      mkdirSync(dirname(shared), { recursive: true });
      writeFileSync(shared, "shared skill\n");
      const harden = f.call("harden");
      assert.equal(harden.status, 0, harden.stderr);
      assert(f.immutable().includes(shared));
      const prematureOwnership = spawnSync(
        join(f.bin, "chown"),
        ["-Rh", "fixture:fixture", join(f.home, ".agents")],
        { env: f.env, encoding: "utf8" },
      );
      assert.notEqual(prematureOwnership.status, 0);
      assert(prematureOwnership.stderr.includes("IMMUTABLE OWNERSHIP/MODE TARGET"));
      for (let window = 0; window < 2; ++window) {
        const result = f.run(scopes);
        assert.equal(result.status, 0, result.stderr);
        assert(f.immutable().includes(shared), "Shared descendants must be re-hardened");
        assert(f.immutable().includes(join(f.native, "skills")));
        assert(result.stdout.includes("hardening restored; gateway remains stopped"));
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
    for (const action of ["validate", "validate-maintenance", "snapshot", "backup"])
      assert.notEqual(f.call(action, join(f.root, `strict-${action}`)).status, 0);
    for (const scope of ["agent-config", "config", "skills"])
      assert.notEqual(f.run([scope]).status, 0);
    assert.equal(f.calls().length, 0, "Normal maintenance must refuse before containment");
    const result = f.recover(backup);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(installed, "tool.js"), "utf8"), "restored package\n");
    const snapshots = f.calls().filter((call) => call[0] === "snapshot");
    assert(snapshots.length > 0);
    assert(snapshots.every((call) => call[1].snapshotVersion === 1));
    assert(
      snapshots.some((call) =>
        call[1].resources.some((item) => item.path === join(f.native, "npm")),
      ),
    );
    assert(f.immutable().includes(join(installed, "tool.js")));
    assert.equal(f.calls().filter((call) => call[0] === "kill-switch").length, 2);
    assert(result.stdout.includes("hardening restored; gateway remains stopped"));
    const normal = f.run(["agent-config"]);
    assert.equal(normal.status, 0, normal.stderr);
  });
});

test("native recovery keeps unsafe path/link and wrong-type package refusals before containment", () => {
  for (const variant of [
    "package-link",
    "package-file",
    "native-link",
    "fixed-link",
    "unsafe-resource",
  ])
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
      if (variant === "package-file") writeFileSync(installed, "not a directory\n");
      if (variant === "native-link") {
        rmSync(join(f.native, "extensions"), { recursive: true });
        symlinkSync(f.root, join(f.native, "extensions"));
      }
      if (variant === "fixed-link") symlinkSync(f.root, join(f.home, ".npm-system-global"));
      if (variant === "unsafe-resource")
        writeFileSync(
          join(f.native, "settings.json"),
          JSON.stringify({ packages: ["npm:fixture-tool"], extensions: ["/outside-fixture"] }),
        );
      const result = f.recover(join(f.root, "not-used"));
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(f.calls().length, 0, variant);
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
    assert.equal(f.calls().length, 0);
    const result = f.recover(backup);
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes("Backup destination mapping differs"));
    assert.equal(readFileSync(marker, "utf8"), "keep on failure\n");
    assert(f.immutable().includes(marker));
    assert.equal(f.calls().filter((call) => call[0] === "kill-switch").length, 2);
    assert(result.stderr.includes("hardening restoration failed; gateway remains stopped"));
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

test("native recovery preflight rejects unrooted backup resources and unsafe sources before unlock", () => {
  for (const variant of ["destination", "declaration", "source-link", "overlap"])
    fixture((f) => {
      f.prepare();
      f.install();
      const external = join(f.home, "reviewed-extension.ts");
      writeFileSync(external, "reviewed external content\n");
      writeFileSync(join(f.native, "settings.json"), JSON.stringify({ extensions: [external] }));
      const backup = join(f.home, "reviewed-backup");
      assert.equal(f.call("backup", backup).status, 0);
      rmSync(join(f.native, "settings.json"));
      const marker = join(f.native, "bin/preflight-marker");
      writeFileSync(marker, "keep before validation\n");
      const manifestPath = join(backup, "mapping.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (variant === "destination") {
        manifest.resources[0].destination = join(f.home, "unreviewed.ts");
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      if (variant === "declaration" || variant === "overlap")
        writeFileSync(
          join(backup, "store-0/settings.json"),
          JSON.stringify({
            extensions: [variant === "declaration" ? "/outside-fixture" : backup],
          }),
        );
      if (variant === "overlap") {
        manifest.resources[0].destination = backup;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      if (variant === "source-link") {
        rmSync(join(backup, "resource-0"));
        symlinkSync(external, join(backup, "resource-0"));
      }
      const result = f.recover(backup);
      assert.notEqual(result.status, 0, variant);
      assert(!result.stdout.includes("[maintenance] unlocking"), result.stdout);
      assert(!f.calls().some(([name]) => name === "service-command"), variant);
      assert.equal(readFileSync(marker, "utf8"), "keep before validation\n");
      assert.equal(readFileSync(external, "utf8"), "reviewed external content\n");
      assert(!f.immutable().includes(join(f.home, "unreviewed.ts")));
    });
});

test("failed recontainment aborts all privileged cleanup and never claims that the gateway stopped", () => {
  for (const outcome of ["kill-failure", "initial-kill-failure"]) {
    fixture((f) => {
      f.prepare();
      f.install();
      const result = f.run(["agent-config"], { FIXTURE_OUTCOME: outcome });
      assert.equal(result.status, 1, result.stderr);
      const calls = f.calls();
      const kills = calls.flatMap((call, index) => (call[0] === "kill-switch" ? [index] : []));
      assert.equal(kills.length, outcome === "kill-failure" ? 2 : 1);
      assert.equal(
        calls.slice(kills.at(-1) + 1).length,
        0,
        "No thaw/chown/chmod after failed containment",
      );
      assert(!`${result.stdout}${result.stderr}`.includes("gateway remains stopped"));
      if (outcome === "kill-failure") {
        assert(result.stderr.includes("gateway state unknown"));
        assert(result.stderr.includes("no privileged repair attempted"));
      }
    });
  }
});

test("private resolved inventory restores removed declarations and protects newly declared resources on success, failure and signal", () => {
  for (const variant of [
    "remove",
    "change-failure",
    "change-signal",
    "invalid-settings",
    "removed-profile",
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
      const outcome =
        variant === "change-failure"
          ? "failure"
          : variant === "change-signal"
            ? "signal"
            : "success";
      const mutation = {
        remove: variant === "remove",
        malformed: variant === "invalid-settings",
        settings: { skills: [added] },
        ...(variant === "removed-profile"
          ? {
              replaceDeployed: JSON.stringify({
                code: { profile: "claude", profiles: { claude: f.settings.code.profiles.claude } },
              }),
            }
          : {}),
      };
      const result = f.run(["agent-config"], {
        FIXTURE_OUTCOME: outcome,
        FIXTURE_MUTATION: JSON.stringify(mutation),
      });
      assert.equal(
        result.status,
        variant === "invalid-settings"
          ? 1
          : outcome === "failure"
            ? 42
            : outcome === "signal"
              ? 143
              : 0,
        result.stderr,
      );
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
      const snapshots = calls.filter((call) => call[0] === "snapshot");
      assert(snapshots.length > 0);
      assert(
        snapshots.some((call) => call[1].resources.some((resource) => resource.path === original)),
        "Snapshot records resolved resources, not just deployment settings",
      );
      if (!["remove", "invalid-settings"].includes(variant)) {
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
    const backupScript = readFileSync(join(f.infra, "bin/backup.sh"), "utf8");
    assert(backupScript.includes('"$LIBEXEC/deployment-policy.mjs" backup'));
    assert(!backupScript.includes('"$SCRIPT_DIR/../deployment-policy.mjs"'));
    assert(backupScript.includes(`LIBEXEC=${f.libexec}`));
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
    const result = spawnSync(
      "bash",
      [f.wrapper, "packages", "--", join(f.root, "service-command")],
      {
        env: f.env,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes("Refusing symlink"));
    assert.equal(f.calls().length, 0);
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
    mapping.stores[0].destination = join(f.root, "escape");
    writeFileSync(join(backup, "mapping.json"), JSON.stringify(mapping));
    assert.notEqual(f.call("recover", backup).status, 0);
    assert(!existsSync(join(f.root, "escape")));
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
    assert.notEqual(f.call("backup", overlapping).status, 0);
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
    const marker = join(f.native, "bin/not-yet-restored");
    writeFileSync(marker, "keep if preflight fails\n");
    const manifest = JSON.parse(readFileSync(join(backup, "mapping.json"), "utf8"));
    manifest.resources.at(-1).destination = join(f.root, "outside");
    writeFileSync(join(backup, "mapping.json"), JSON.stringify(manifest));
    assert.notEqual(f.call("recover", backup).status, 0);
    assert(existsSync(marker), "Validate the complete backup before deleting anything");
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

test("pinned native Pi loader keeps empty system files neutral and normal auth/lock writes work", () => {
  fixture((f) => {
    f.prepare();
    writeFileSync(
      join(f.native, "bin/managed-native-tool"),
      "#!/bin/sh\nprintf 'managed native bin'\n",
      { mode: 0o755 },
    );
    const child = join(f.root, "native-check.mjs");
    const moduleRoot = join(repository, "node_modules/@earendil-works/pi-coding-agent/dist/core");
    writeFileSync(
      child,
      `
      import assert from 'node:assert/strict';
      import { readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { FileAuthStorageBackend } from ${JSON.stringify(join(moduleRoot, "auth-storage.js"))};
      import { SettingsManager } from ${JSON.stringify(join(moduleRoot, "settings-manager.js"))};
      import { DefaultResourceLoader, loadProjectContextFiles } from ${JSON.stringify(join(moduleRoot, "resource-loader.js"))};
      import { buildSystemPrompt } from ${JSON.stringify(join(moduleRoot, "system-prompt.js"))};
      import { ProjectTrustStore } from ${JSON.stringify(join(moduleRoot, "trust-manager.js"))};
      import { FileModelsStore } from ${JSON.stringify(join(moduleRoot, "models-store.js"))};
      import { createBashTool } from ${JSON.stringify(join(moduleRoot, "tools/bash.js"))};
      const dir = process.env.PI_CODING_AGENT_DIR;
      const bash = createBashTool(process.cwd());
      const toolResult = await bash.execute('managed-bin-check', { command: 'managed-native-tool' });
      assert(toolResult.content.some(item => item.type === 'text' && item.text.includes('managed native bin')));
      const auth = join(dir, 'auth.json');
      const backend = new FileAuthStorageBackend(auth);
      backend.withLock(() => ({ next: '{}', result: null }));
      await backend.withLockAsync(async () => ({ next: '{"fixture":{"type":"api_key","key":"fake"}}', result: null }));
      assert(!existsSync(auth + '.lock'));
      const catalog = new FileModelsStore(join(dir, 'models-store.json'));
      await catalog.write('fixture', {models: [], checkedAt: 1});
      assert.deepEqual(await catalog.read('fixture'), {models: [], checkedAt: 1});
      assert(!existsSync(join(dir, 'models-store.json.lock')));
      writeFileSync(auth + '.replacement', '{}'); renameSync(auth + '.replacement', auth);
      const settings = SettingsManager.create(process.cwd(), dir);
      const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
      await loader.reload();
      assert.equal(loader.getExtensions().errors.length, 0);
      const trust = new ProjectTrustStore(dir);
      trust.set(process.cwd(), true);
      assert.equal(trust.get(join(process.cwd(), 'future-worktree')), true);
      assert(!existsSync(join(dir, 'trust.json.lock')));
      const prompt = readFileSync(loader.discoverSystemPromptFile(), 'utf8');
      assert.equal(prompt, '');
      assert.equal(buildSystemPrompt({cwd: process.cwd(), customPrompt: prompt, appendSystemPrompt: loader.getAppendSystemPrompt().join('\\n\\n')}), buildSystemPrompt({cwd: process.cwd()}));
      const context = loadProjectContextFiles({cwd: process.cwd(), agentDir: dir});
      assert(context.some((file) => file.path === join(dir, 'AGENTS.md')));
      assert(!context.some((file) => file.path.endsWith('AGENTS.override.md')));
      assert(!existsSync(join(dir, 'settings.json.lock')));
    `,
    );
    const result = spawnSync(process.execPath, [child], {
      cwd: f.home,
      env: { ...f.env, PI_CODING_AGENT_DIR: f.native, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const cli = spawnSync(process.execPath, [join(moduleRoot, "../cli.js"), "--list-models"], {
      cwd: f.home,
      env: {
        ...f.env,
        PI_CODING_AGENT_DIR: f.native,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
  });
});

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "deployment-core-"));
  const home = join(root, "home");
  const infra = join(root, "admin/infra/openclaw");
  const bin = join(root, "doubles");
  const settingsFile = join(infra, "aligndev.settings.json");
  const deployed = join(home, ".alignfirst/aligndev.settings.json");
  const log = join(root, "calls.jsonl");
  const f = {
    root,
    home,
    infra,
    libexec: join(root, "opt/fixture/libexec"),
    bin,
    settingsFile,
    deployed,
    log,
    native: join(home, ".pi/agent"),
    wrapper: join(infra, "bin/assistant-maintenance.sh"),
  };
  f.env = {
    HOME: home,
    USER: "fixture",
    LOGNAME: "fixture",
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: root,
    FIXTURE_ROOT: root,
    FIXTURE_LOG: log,
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
        profile: "main",
        defaultProfiles: { pi: "custom", claude: "claude" },
        profiles: {
          main: {
            agent: "pi",
            configDir: "~/.pi/agent",
            quota: { source: "codex", configDir: "~/.codex-quota" },
          },
          shared: { agent: "pi", configDir: "~/.pi/agent" },
          custom: { agent: "pi", configDir: "~/custom-pi" },
          claude: { agent: "claude", configDir: "~/.claude" },
        },
      },
    };
    f.save = () => writeFileSync(settingsFile, JSON.stringify(f.settings));
    f.save();
    f.call = (action, argument) =>
      spawnSync(
        process.execPath,
        [
          join(infra, "deployment-policy.mjs"),
          action,
          settingsFile,
          home,
          deployed,
          ...(argument === undefined ? [] : [argument]),
        ],
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
    f.immutable = () =>
      existsSync(join(root, "immutable.json"))
        ? JSON.parse(readFileSync(join(root, "immutable.json"), "utf8"))
        : [];
    f.recover = (backup) =>
      spawnSync("bash", [f.wrapper, "native-recovery", "--", backup], {
        env: f.env,
        encoding: "utf8",
        timeout: 30_000,
      });
    f.calls = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    f.run = (scopes, env = {}) =>
      spawnSync("bash", [f.wrapper, ...scopes, "--", join(f.root, "service-command")], {
        env: { ...f.env, ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
    f.install = () => {
      mkdirSync(dirname(deployed), { recursive: true });
      cpSync(settingsFile, deployed);
    };
    installDoubles(f);
    callback(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function installDoubles(f) {
  const double = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, writeFileSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
function inside(path) { if (!path.startsWith(root + '/')) throw new Error('OUTSIDE FIXTURE: ' + path); }
function log(value) { appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + '\\n'); }
if (name === 'id') { if (args.join(' ') === '-u') console.log('0'); else if (args.join(' ') === '-u fixture') console.log('1000'); else if (args.join(' ') === '-gn fixture' || args.join(' ') === '-un') console.log('fixture'); else throw new Error('Unexpected id'); }
else if (['chown', 'chmod', 'chattr'].includes(name)) {
  const recursive = args[0] === '-R' || args[0] === '-Rh';
  const mode = args[recursive ? 1 : 0];
  const paths = args.slice(recursive ? 2 : 1);
  if (paths.length === 0) throw new Error('Missing privileged target');
  if (recursive && !(args.length === 3 && (
    (name === 'chown' && [root + '/home/seed', root + '/home/.npm-system-global', root + '/home/.agents', root + '/home/.openclaw/skills'].includes(args[2])) ||
    (name === 'chmod' && mode === 'go-w' && args[2] === root + '/home/.npm-system-global') ||
    (name === 'chmod' && mode === 'go-rwx' && args[2].startsWith(root + '/home/backups/deployment/'))
  ))) throw new Error('Unexpected recursive privileged arguments');
  if (name === 'chown' && !['fixture:fixture', 'root:fixture', 'root:root', 'operator:operator'].includes(mode)) throw new Error('Unexpected chown owner');
  if (name === 'chmod' && !['600', '640', '644', '755', '1770', '700', ...(recursive ? ['go-w', 'go-rwx'] : [])].includes(mode)) throw new Error('Unexpected chmod mode');
  if (name === 'chattr' && (args.length !== 2 || !['-i', '+i'].includes(mode))) throw new Error('Unexpected chattr operation');
  for (const path of paths) inside(path);
  log([name, ...args]);
  const stateFile = root + '/immutable.json';
  const immutable = new Set(existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []);
  if (name === 'chattr') {
    if (mode === '-i' && process.env.FIXTURE_OUTCOME === 'partial-unlock' && !existsSync(root + '/failed-once')) { writeFileSync(root + '/failed-once', ''); process.exit(1); }
    if (mode === '+i') immutable.add(paths[0]); else immutable.delete(paths[0]);
    writeFileSync(stateFile, JSON.stringify([...immutable]));
  } else {
    function check(path) {
      inside(path);
      if (immutable.has(path)) throw new Error('IMMUTABLE OWNERSHIP/MODE TARGET: ' + path);
      if (recursive && existsSync(path) && lstatSync(path).isDirectory())
        for (const child of readdirSync(path)) check(path + '/' + child);
    }
    for (const path of paths) check(path);
  }
} else if (name === 'install') {
  if (args.length === 8 && args.slice(0, 6).join(' ') === '-m 644 -o root -g root') {
    inside(args[6]); inside(args[7]);
    if (args[6] !== root + '/admin/infra/openclaw/aligndev.settings.json' || !args[7].endsWith('/settings.json')) throw new Error('Unexpected settings copy');
    cpSync(args[6], args[7]);
  } else {
    const directory = args.length === 4 && args.slice(0, 3).join(' ') === '-d -m 700' && args[3] === root + '/home/backups/deployment';
    const file = args.length === 5 && args.slice(0, 3).join(' ') === '-D -m 600' && args[3].startsWith(root + '/home/') && args[4].startsWith(root + '/home/backups/deployment/');
    if (!directory && !file) throw new Error('Unexpected install');
    const result = spawnSync('/usr/bin/install', args, {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  log([name, ...args]);
} else if (name === 'rsync') {
  if (args[0] !== '-a' || args[1] !== '--delete' || args.length !== 4) throw new Error('Unexpected rsync');
  inside(args[2]); inside(args[3]); mkdirSync(args[3], {recursive:true}); cpSync(args[2], args[3], {recursive:true}); log([name, ...args]);
} else if (name === 'openclaw') {
  if (args.length !== 6 || args[0] !== 'backup' || args[1] !== 'create' || args[2] !== '--output' || args[4] !== '--no-include-workspace' || args[5] !== '--verify') throw new Error('Unexpected openclaw');
  inside(args[3]); log([name, ...args]);
} else if (name === 'kill-switch') {
  if (args.length !== 0) throw new Error('Unexpected kill arguments');
  log([name]);
  if (process.env.FIXTURE_OUTCOME === 'initial-kill-failure' ||
    (existsSync(root + '/service-ran') && process.env.FIXTURE_OUTCOME === 'kill-failure')) process.exit(1);
}
else if (name === 'runuser') {
  if (args[0] !== '-u' || args[1] !== 'fixture' || args[2] !== '--' || args[3] !== 'env' || args[4] !== 'HOME=' + root + '/home' || args[5] !== 'USER=fixture' || args[6] !== 'LOGNAME=fixture' || args[7] !== 'XDG_RUNTIME_DIR=/run/user/1000' || !args[8].startsWith('PATH=/usr/bin:/opt/fixture/bin:/bin:') || args[9] !== 'bash' || args[10] !== '-c' || args[11] !== 'cd "$HOME" && exec "$@"' || args[12] !== 'bash') throw new Error('Unexpected runuser');
  const command = args.slice(13);
  const recovery = command.length === 7 && command[0] === process.execPath && command[1] === root + '/opt/fixture/libexec/deployment-policy.mjs' && command[2] === 'recover' && command[3].startsWith(root + '/tmp.') && command[3].endsWith('/settings.json') && command[4] === root + '/home' && command[5] === root + '/home/.alignfirst/aligndev.settings.json';
  if (!recovery && (command.length !== 1 || command[0] !== root + '/service-command')) throw new Error('Unexpected service command');
  if (recovery) inside(command[6]);
  log(['service-command']);
  writeFileSync(root + '/service-ran', '');
  {
    const snapshots = readdirSync(root).filter(name => name.startsWith('tmp.'));
    for (const name of snapshots) {
      const dir = root + '/' + name;
      if (!statSync(dir).isDirectory()) continue;
      if (recovery && dir + '/settings.json' === command[3]) {
        if ((statSync(dir).mode & 0o022) !== 0) throw new Error('Recovery settings directory is writable');
        if (readFileSync(command[3], 'utf8') !== readFileSync(root + '/admin/infra/openclaw/aligndev.settings.json', 'utf8')) throw new Error('Recovery settings differ from review');
        continue;
      }
      if (statSync(dir).uid !== process.getuid()) throw new Error('Snapshot owner differs from wrapper owner');
      if ((statSync(dir).mode & 0o077) !== 0) throw new Error('Snapshot directory is not private');
      for (const file of readdirSync(dir)) {
        if ((statSync(dir + '/' + file).mode & 0o077) !== 0) throw new Error('Snapshot file is not private');
        log(['snapshot', JSON.parse(readFileSync(dir + '/' + file, 'utf8'))]);
      }
    }
  }
  if (recovery) {
    const result = spawnSync(command[0], command.slice(1), {env: process.env, stdio: 'inherit', timeout: 20_000});
    process.exit(result.status ?? 1);
  }
  if (process.env.FIXTURE_MUTATION) {
    const mutation = JSON.parse(process.env.FIXTURE_MUTATION);
    const nativeSettings = root + '/home/.pi/agent/settings.json';
    if (mutation.remove) rmSync(nativeSettings);
    else if (mutation.malformed || mutation.settings !== undefined) writeFileSync(nativeSettings, mutation.malformed ? '{invalid' : JSON.stringify(mutation.settings));
    if (mutation.packageLink) {
      inside(mutation.packageLink);
      symlinkSync(mutation.packageLink, root + '/home/.npm-system-global/bin/tool');
    }
    if (mutation.replaceDeployed) writeFileSync(root + '/home/.alignfirst/aligndev.settings.json', mutation.replaceDeployed);
  }
  if (process.env.FIXTURE_OUTCOME === 'signal') { process.kill(process.ppid, 'SIGTERM'); process.exit(143); }
  if (process.env.FIXTURE_OUTCOME === 'failure') process.exit(42);
} else throw new Error('Unexpected command ' + name);
`;
  for (const name of ["id", "chown", "chmod", "chattr", "install", "rsync", "runuser", "openclaw"])
    writeFileSync(join(f.bin, name), double, { mode: 0o755 });
  writeFileSync(join(f.root, "kill-switch"), double, { mode: 0o755 });
  writeFileSync(join(f.root, "service-command"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
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
