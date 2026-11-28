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
const resourceProbe = fileURLToPath(
  new URL("./fixtures/deployment-resource-probe.mjs", import.meta.url),
);
// Deployment hardening makes these root-owned; the service account only reads them.
const managedFiles = {
  "settings.json": "{}",
  "models.json": "{}",
  "mcp.json": "{}",
  "trust.json": "{}",
  "AGENTS.md": "Fixture managed instructions",
  "SYSTEM.md": "",
  "APPEND_SYSTEM.md": "",
};

// The pinned Pi must keep the deployment's assumptions; these probes do not certify OS hardening.
test("pinned Pi discovers reserved resources, starts without a prompt and writes credentials beside read-only resources", () => {
  withFixture((fixture) => {
    assert.deepEqual(JSON.parse(runNode(fixture, [resourceProbe])), {
      emptyPromptReservationsNeutral: true,
      alternateInstructionsDiscovered: true,
      parentTrustInherited: true,
      closerTrustOverrides: true,
      nativeSettingsPersisted: true,
    });
    for (const [name, text] of Object.entries(managedFiles)) {
      writeFileSync(join(fixture.agentDir, name), text);
      chmodSync(join(fixture.agentDir, name), 0o444);
    }
    chmodSync(join(fixture.agentDir, "AGENTS.override.md"), 0o555);
    writeFileSync(
      join(fixture.agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-only" } }),
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      ["--import", guard, piCli, "--offline", "--mode", "rpc", "--no-session"],
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
    const records = result.stdout
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
    assert(!result.stdout.includes("fixture-only"));
    assert.deepEqual(JSON.parse(runNode(fixture, [storageProbe])), {
      adjacentLockObserved: true,
      credentialUpdated: true,
      lockRemoved: true,
    });
  });
});

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "deployment-native-"));
  const home = join(root, "home");
  const cwd = join(home, "project");
  const agentDir = join(home, ".pi/agent");
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
  };
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{}");
    run({ root, cwd, agentDir, env });
  } finally {
    if (existsSync(join(agentDir, "AGENTS.override.md")))
      chmodSync(join(agentDir, "AGENTS.override.md"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
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
