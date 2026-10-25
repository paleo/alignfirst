import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const piManifest = JSON.parse(readFileSync(new URL("../package.json", piEntry), "utf8"));
const piCli = fileURLToPath(new URL(`../${piManifest.bin.pi}`, piEntry));
const guard = fileURLToPath(new URL("./fixtures/deployment-deny-network.mjs", import.meta.url));
const storageProbe = fileURLToPath(
  new URL("./fixtures/deployment-storage-probe.mjs", import.meta.url),
);

// Preserve the accepted auth.json persistence risk; these probes do not certify OS hardening.
test("deployment audit uses the pinned native package and declared npm entry", () => {
  assert.equal(piManifest.version, "1.3.0", "Re-audit native storage on Pi upgrades");
  assert.equal(piManifest.engines.node, ">=22.19.0");
  assert.equal(piManifest.bin.pi, "dist/bundle/cli.js");
  assert(existsSync(piCli));
});

for (const custom of [false, true]) {
  const directoryKind = custom ? "custom" : "default";
  test(`approved exception: mutable ${directoryKind} auth persists commands across CLI startups`, () => {
    withFixture(custom, (fixture) => {
      const authPath = join(fixture.agentDir, "auth.json");
      const sentinel = join(fixture.root, "command-ran");
      writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "fixture-only" } }));
      runListModels(fixture);
      assert(!existsSync(sentinel), "Literal credential is the negative control");

      // Same-user mutation persists independently of the process that wrote the file.
      writeFileSync(
        authPath,
        JSON.stringify({
          openai: {
            type: "api_key",
            key: `!printf executed > ${shellQuote(sentinel)}; printf fixture-only`,
          },
        }),
      );
      runListModels(fixture);
      assert.equal(readFileSync(sentinel, "utf8"), "executed");
      rmSync(sentinel);
      runListModels(fixture);
      assert.equal(
        readFileSync(sentinel, "utf8"),
        "executed",
        "Persists across fresh Pi processes",
      );
    });
  });

  test(`${directoryKind} no-prompt RPC startup and credential writes coexist with read-only resources`, () => {
    withFixture(custom, (fixture) => {
      for (const [name, text] of Object.entries({
        "settings.json": "{}",
        "models.json": "{}",
        "mcp.json": "{}",
        "trust.json": "{}",
        "AGENTS.md": "Fixture managed instructions",
        "SYSTEM.md": "",
        "APPEND_SYSTEM.md": "",
      })) {
        writeFileSync(join(fixture.agentDir, name), text);
        chmodSync(join(fixture.agentDir, name), 0o444);
      }
      mkdirSync(join(fixture.agentDir, "AGENTS.override.md"), { mode: 0o555 });
      writeFileSync(
        join(fixture.agentDir, "auth.json"),
        JSON.stringify({
          openai: { type: "api_key", key: "fixture-only" },
        }),
        { mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          guard,
          piCli,
          "--offline",
          "--mode",
          "rpc",
          "--no-session",
          "--provider",
          "openai",
          "--model",
          "gpt-4o-mini",
        ],
        {
          cwd: fixture.cwd,
          env: fixture.env,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          input: '{"id":"fixture-state","type":"get_state"}\n',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "", "Startup must not hide read-only resource failures");
      const output = result.stdout;
      const records = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const state = records.find((record) => record.id === "fixture-state");
      assert.equal(state?.type, "response");
      assert.equal(state?.success, true);
      assert.equal(state?.data.isStreaming, false);
      assert(
        !records.some((record) => record.type === "message_start"),
        "No model turn was requested",
      );
      assert(!output.includes("fixture-only"));
      assert.deepEqual(JSON.parse(runNode(fixture, [storageProbe, "mutable"])), {
        adjacentLockObserved: true,
        credentialUpdated: true,
        lockRemoved: true,
      });
    });
  });

  test(`${directoryKind} native discovery, empty prompt reservations and saved parent trust`, () => {
    withFixture(custom, (fixture) => {
      const probe = fileURLToPath(
        new URL("./fixtures/deployment-resource-probe.mjs", import.meta.url),
      );
      assert.deepEqual(JSON.parse(runNode(fixture, [probe])), {
        emptyPromptReservationsNeutral: true,
        alternateInstructionsDiscovered: true,
        parentTrustInherited: true,
        closerTrustOverrides: true,
        nativeSettingsPersisted: true,
      });
    });
  });

  test(`read-only ${directoryKind} credentials cannot satisfy native storage`, {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, () => {
    withFixture(custom, (fixture) => {
      assert.deepEqual(JSON.parse(runNode(fixture, [storageProbe, "permissions"])), {
        fileWriteDenied: true,
        parentLockDenied: true,
        noLockRemains: true,
      });
    });
  });
}

function withFixture(custom, run) {
  const root = mkdtempSync(join(tmpdir(), "side25-b8-native-"));
  const home = join(root, "home");
  const cwd = join(home, "project");
  const agentDir = custom ? join(root, "custom-agent") : join(home, ".pi/agent");
  const env = {
    HOME: home,
    USER: "fixture",
    LOGNAME: "fixture",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    DEPLOYMENT_FIXTURE_ROOT: root,
    ...(custom ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{}");
    run({ root, cwd, agentDir, env });
  } finally {
    // Also recover the fixture mode if a storage subprocess fails before its finally block.
    if (existsSync(agentDir)) chmodSync(agentDir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

function runListModels(fixture) {
  const output = runNode(fixture, [
    piCli,
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--list-models",
    "side25-b8-no-such-model",
  ]);
  assert(!output.includes("fixture-only"), "Do not print even fixture credential values");
}

function runNode(fixture, args) {
  return execFileSync(process.execPath, ["--import", guard, ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
