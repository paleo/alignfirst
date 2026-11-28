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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  installStandIns,
  journalCalls,
  readJournal,
  replayState,
  standInEnv,
} from "./fixtures/deployment-standins.mjs";

const template = fileURLToPath(
  new URL(
    "../../skills/aligndev-openclaw-setup/assets/aligndev-openclaw-template/",
    import.meta.url,
  ),
);
const networkGuard = fileURLToPath(
  new URL("./fixtures/deployment-deny-network.mjs", import.meta.url),
);
const agents = {
  claude: { overlay: "claude-code", directory: ".claude", instructions: "CLAUDE.md" },
  codex: { overlay: "codex", directory: ".codex", instructions: "AGENTS.md" },
  pi: { overlay: "pi", directory: ".pi/agent", instructions: "AGENTS.md" },
};

// Ownership and immutable flags are modeled; no real root identity or privileged tools are used.
for (const agent of Object.keys(agents)) {
  test(`${agent}: hardened anchors survive unchanged config and changed instructions reseeds`, () => {
    withFixture(agent, (f) => {
      assert(!existsSync(f.native));
      f.seed(0, false);
      assert.equal(statSync(f.native).mode & 0o7777, 0o700, "Create absent anchor privately");
      writeFileSync(f.instructions, `Operator text\n\n${readFileSync(f.instructions, "utf8")}`);
      f.policy("harden");
      const original = readFileSync(f.instructions, "utf8");
      const before = statSync(f.instructions).mtimeMs;
      const anchor = f.state()[f.native];
      assert.deepEqual(anchor, { owner: "root", mode: 0o1770, immutable: false });
      assert.equal(f.state()[f.instructions].immutable, true);
      const installCount = f.calls().filter(([name]) => name === "install").length;

      // Ordinary config maintenance does not unlock any native scope.
      f.seed();
      assert.equal(statSync(f.instructions).mtimeMs, before);
      assert.equal(readFileSync(f.instructions, "utf8"), original);
      assert.deepEqual(f.state()[f.native], anchor);
      assert.equal(
        f.calls().filter(([name]) => name === "install").length,
        installCount,
        "Unchanged reseed must not install either the existing anchor or instructions",
      );

      writeFileSync(f.instructionSource, "Changed fixture instructions\n");
      f.seed(1);
      assert.equal(readFileSync(f.instructions, "utf8"), original);
      f.policy("unlock", "agent-skills");
      f.seed(1);
      assert.equal(readFileSync(f.instructions, "utf8"), original);
      f.policy("harden", "agent-skills");

      f.policy("unlock", "instructions");
      assert.equal(f.state()[f.instructions].owner, "service");
      assert.equal(f.state()[f.instructions].immutable, false);
      assert.deepEqual(f.state()[f.native], anchor, "Instruction scope never thaws its anchor");
      f.seed();
      assert.equal(
        readFileSync(f.instructions, "utf8"),
        "Operator text\n\n<!-- alignfirst-dev-kit:start -->\nChanged fixture instructions\n" +
          "<!-- alignfirst-dev-kit:end -->\n",
      );
      assert.deepEqual(f.state()[f.native], anchor);
      f.policy("harden", "instructions");
      assert.equal(f.state()[f.instructions].owner, "root");
      assert.equal(f.state()[f.instructions].immutable, true);
      assert.deepEqual(f.state()[f.native], anchor);
      const changedTime = statSync(f.instructions).mtimeMs;
      f.seed();
      assert.equal(statSync(f.instructions).mtimeMs, changedTime);
    });
  });
}

test("Pi rejects reserved fnm overlaps before any mutation", () => {
  for (const declaration of [
    "~/.local/share/fnm",
    "~/.local/share/fnm/node-versions",
    "~/.local/share",
  ]) {
    withFixture("pi", (f) => {
      const runtime = join(f.home, ".local/share/fnm/node-versions/fixture/installation/bin");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "node"), "fixture runtime\n", { mode: 0o755 });
      mkdirSync(f.native, { recursive: true });
      writeFileSync(join(f.native, "settings.json"), JSON.stringify({ packages: [declaration] }));
      const before = treeState(f.home);
      for (const action of ["inventory", "prepare"]) {
        f.policy(action, undefined, 1);
        assert.deepEqual(treeState(f.home), before, `${declaration}: ${action}`);
      }
    });
  }
});

test("Pi permits a local package beside the reserved fnm tree", () => {
  withFixture("pi", (f) => {
    const packageRoot = join(f.home, ".local/share/fnm-tools");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), "{}\n");
    mkdirSync(f.native, { recursive: true });
    writeFileSync(
      join(f.native, "settings.json"),
      JSON.stringify({ packages: ["~/.local/share/fnm-tools"] }),
    );
    f.policy("inventory");
    const inventory = JSON.parse(f.last.stdout);
    assert(inventory.resources.some((resource) => resource.path === packageRoot));
    assert.deepEqual(f.calls(), []);
  });
});

function withFixture(agent, callback) {
  const root = mkdtempSync(join(tmpdir(), "deployment-reseed-boundaries-"));
  const home = join(root, "home");
  const infra = join(root, "infra");
  const bin = join(root, "bin");
  const definition = agents[agent];
  const native = join(home, definition.directory);
  const journal = join(root, "journal");
  const settings = join(infra, "aligndev.settings.json");
  const deployed = join(home, ".alignfirst/aligndev.settings.json");
  const f = {
    root,
    home,
    native,
    instructions: join(native, definition.instructions),
    instructionSource: join(infra, "coding-agent", definition.instructions),
    state: () => replayState(readJournal(journal)),
    calls: () => journalCalls(readJournal(journal)),
  };
  try {
    mkdirSync(home);
    mkdirSync(bin);
    cpSync(join(template, "base/infra/openclaw"), infra, { recursive: true });
    cpSync(join(template, "variants/coding-agents", definition.overlay, "infra/openclaw"), infra, {
      recursive: true,
    });
    // Only the disposable copy bypasses the root check; production has no fixture switch.
    const policy = join(infra, "deployment-policy.mjs");
    writeFileSync(
      policy,
      readFileSync(policy, "utf8")
        .replaceAll("{{SERVICE_USER}}", "fixture")
        .replace("process.getuid() !== 0", "false"),
    );
    const functions = join(root, "seed-functions.sh");
    writeFileSync(
      functions,
      readFileSync(join(infra, "seed.sh"), "utf8")
        .replace(/main "\$@"\s*$/u, "")
        .replaceAll("/usr/bin/node", process.execPath),
    );
    writeFileSync(
      settings,
      JSON.stringify({
        code: {
          profiles: {
            openclaw: { harness: "openclaw", defaultAgentProfile: "fixture" },
            fixture: { harness: agent, configDir: native },
          },
        },
      }),
    );
    writeFileSync(journal, "");
    for (const name of ["bash", "dirname", "sed", "tr", "cmp", "mktemp", "rm", "jq"])
      symlinkSync(`/usr/bin/${name}`, join(bin, name));
    symlinkSync(process.execPath, join(bin, "node"));
    installStandIns(bin, ["id", ["install", "install.mjs"], "chown", "chmod", "chattr"]);
    const env = {
      ...standInEnv({ root, home, bin, journal }),
      HOME: home,
      PATH: bin,
      TMPDIR: root,
      NODE_OPTIONS: `--import=${networkGuard}`,
    };
    f.run = (command, args, role, expected) => {
      f.last = spawnSync(command, args, {
        cwd: home,
        env: { ...env, STANDIN_ROLE: role },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(f.last.status, expected, `${command} ${args.join(" ")}\n${f.last.stderr}`);
    };
    f.policy = (action, scope, expected = 0) =>
      f.run(
        process.execPath,
        [policy, action, settings, home, deployed, ...(scope === undefined ? [] : [scope])],
        "root",
        expected,
      );
    f.seed = (expected = 0, prepare = true) =>
      f.run(
        "/bin/bash",
        [
          "-euc",
          'source "$1"; DIR="$2"; source "$DIR/seed/common.sh"; ' +
            'source "$DIR/seed/coding-agent.sh"; load_deployment_profiles; ' +
            (prepare ? "configure_deployment_agents" : "configure_coding_agent"),
          "fixture",
          functions,
          infra,
        ],
        "service",
        expected,
      );
    callback(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function treeState(root) {
  const stat = statSync(root);
  return {
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    mtime: stat.mtimeMs,
    ...(stat.isDirectory()
      ? {
          children: Object.fromEntries(
            readdirSync(root).map((name) => [name, treeState(join(root, name))]),
          ),
        }
      : { content: readFileSync(root, "utf8") }),
  };
}
