import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
const stateDir = join(dirname(log), "docker-state");

appendFileSync(
  log,
  `${JSON.stringify({
    args,
    pid: process.pid,
    config: process.env.OPENCLAW_CONFIG_PATH,
    workspace: process.env.OPENCLAW_WORKSPACE_DIR,
    logs: process.env.OPENCLAW_TEST_GATEWAY_LOGS_DIR,
    project: process.env.OPENCLAW_TEST_PROJECT_DIR,
    uid: process.env.ASSISTANT_UID,
    gid: process.env.ASSISTANT_GID,
  })}\n`,
);
mkdirSync(stateDir, { recursive: true });
main();

function main() {
  if (matches(args, ["info", "--format", "{{.ID}}"])) {
    if (process.env.FAKE_FAIL_INFO !== undefined) process.exit(1);
    console.log(process.env.FAKE_DAEMON_ID ?? "fake-daemon");
    return;
  }
  if (matches(args, ["buildx", "ls", "--format", "json"])) return;
  if (args.length === 3 && matches(args.slice(0, 2), ["image", "inspect"])) {
    process.exit(process.env.FAKE_BASE_MISSING === "1" && args[2].startsWith("paleo/") ? 1 : 0);
  }
  if (
    args.length === 10 &&
    args[0] === "build" &&
    args[1] === "-f" &&
    args[3] === "-t" &&
    args[5] === "--build-arg" &&
    args[7] === "--build-arg" &&
    args[2].endsWith("/Dockerfile.base") &&
    args[4].startsWith("paleo/openclaw-test-base:") &&
    args[6] === `ASSISTANT_UID=${process.env.ASSISTANT_UID}` &&
    args[8] === `ASSISTANT_GID=${process.env.ASSISTANT_GID}` &&
    args[9] === dirname(args[2])
  )
    return;
  if (args.length === 2 && args[0] === "inspect") {
    if (process.env.FAKE_FAIL_INSPECT !== undefined) process.exit(1);
    const container = containers().find((entry) => entry.Id === args[1]);
    if (!container) process.exit(1);
    const malformed = process.env.FAKE_MALFORMED_INSPECT !== undefined;
    console.log(JSON.stringify([malformed ? { ...container, Mounts: null } : container]));
    return;
  }
  if (matches(args, ["ps", "--all", "--quiet", "--no-trunc"])) {
    if (process.env.FAKE_FAIL_PS !== undefined) process.exit(1);
    console.log(
      containers()
        .map((entry) => entry.Id)
        .join("\n"),
    );
    return;
  }
  if (matches(args, ["compose", "ls", "--all", "--format", "json"])) {
    if (process.env.FAKE_FAIL_LS !== undefined) process.exit(1);
    console.log(JSON.stringify(containers().map((entry) => ({ Name: entry.project }))));
    return;
  }
  if (args[0] !== "compose") unexpected();
  let offset = 1;
  if (args[offset] === "--env-file" && args[offset + 1] !== undefined) offset += 2;
  if (
    args[offset] !== "-f" ||
    args[offset + 1] === undefined ||
    args[offset + 2] !== "-p" ||
    args[offset + 3] === undefined
  )
    unexpected();
  const project = args[offset + 3];
  const command = args.slice(offset + 4);
  const statePath = join(stateDir, `${project}.json`);
  if (matches(command, ["build", "bus"])) return;
  if (matches(command, ["ps", "--services", "--filter", "status=running"])) {
    if (process.env.FAKE_FAIL_PS !== undefined) process.exit(1);
    if (existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).running) {
      console.log("bus\ngateway");
    }
    return;
  }
  const up =
    matches(command, ["up", "-d", "--force-recreate", "--wait", "bus", "gateway"]) ||
    matches(command, ["up", "-d", "--wait", "--remove-orphans", "bus", "gateway"]);
  const down = matches(command, ["down"]);
  const run =
    matches(command.slice(0, 4), ["run", "--rm", "--use-aliases", "runner"]) &&
    validRunOptions(command.slice(4));
  if (!up && !down && !run) unexpected();
  if (up) {
    writeFileSync(
      statePath,
      JSON.stringify({
        Id: `${project}-gateway`,
        project,
        running: true,
        Mounts: [{ Type: "bind", Source: process.env.OPENCLAW_CONFIG_PATH }],
      }),
    );
  }
  if (down && process.env.FAKE_REMOVE_BEFORE_DOWN !== undefined) rmSync(statePath, { force: true });
  if (
    process.env.FAKE_HANG === command[0] &&
    (process.env.FAKE_HANG_WORKER === undefined ||
      project.endsWith(`-w${process.env.FAKE_HANG_WORKER}`))
  ) {
    hang();
    return;
  }
  if (up && process.env.FAKE_FAIL_UP !== undefined) {
    console.error("fake recreate failure");
    process.exit(Number(process.env.FAKE_FAIL_UP));
  }
  if (down && process.env.FAKE_FAIL_DOWN !== undefined)
    process.exit(Number(process.env.FAKE_FAIL_DOWN));
  if (down && process.env.FAKE_KEEP_CONTAINERS === undefined) rmSync(statePath, { force: true });
  if (run) writeResult(command);
}

function matches(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function validRunOptions(options) {
  const remaining = new Set([
    "--scenario",
    "--channel",
    "--model-id",
    "--model-ref",
    "--iteration-index",
    "--iteration-width",
    "--base-stamp",
    "--results-dir",
  ]);
  if (options.length !== remaining.size * 2) return false;
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i];
    const value = options[i + 1];
    if (!remaining.delete(flag) || value === undefined || value === "" || value.startsWith("--"))
      return false;
    if (flag === "--iteration-index" || flag === "--iteration-width") {
      const min = flag === "--iteration-index" ? 1 : 0;
      const number = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isInteger(number) || number < min) return false;
    }
  }
  return remaining.size === 0;
}

function containers() {
  return readdirSync(stateDir).map((name) =>
    JSON.parse(readFileSync(join(stateDir, name), "utf8")),
  );
}

function unexpected() {
  appendFileSync(log, `${JSON.stringify({ unexpected: args })}\n`);
  console.error(`Unexpected fake Docker argv: ${JSON.stringify(args)}`);
  process.exit(2);
}

function hang() {
  const worker = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  appendFileSync(log, `${JSON.stringify({ worker: worker.pid })}\n`);
  // Cancellation must escalate and join the parent and its resistant child.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  worker.stdout.once("data", () => console.log("FAKE_RUNNING"));
  setInterval(() => {}, 1000);
}

function writeResult(command) {
  const value = (flag) => command[command.indexOf(flag) + 1];
  const scenarioId = value("--scenario");
  const model = value("--model-id");
  const channel = value("--channel");
  const iterationIndex = Number(value("--iteration-index"));
  const width = Number(value("--iteration-width"));
  const suffix = width === 0 ? "" : `-#${String(iterationIndex).padStart(width, "0")}`;
  const dir = join(process.env.OPENCLAW_TEST_ARTIFACTS_DIR, value("--base-stamp"), "cells");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${model}-${scenarioId}-${channel}${suffix}.json`),
    JSON.stringify({
      schemaVersion: 3,
      scenarioId,
      model,
      channel,
      iterationIndex,
      verdict: "pass",
      durationMs: 1,
      conversationId: "offline",
      artifactDirName: "offline-PASS",
      agentCostUsd: 0,
      agentTurns: 0,
      judgeUsd: 0,
      judgeUsages: [],
    }),
  );
  console.log("FAKE_RUN_STDOUT");
  console.error("FAKE_RUN_STDERR");
}
