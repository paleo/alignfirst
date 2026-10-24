import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
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
if (args[0] === "buildx") process.exit(0);
if (args[0] === "image") process.exit(0);
if (args.includes("ls")) {
  console.log("[]");
  process.exit(0);
}
if (args.includes("ps")) process.exit(0);
if (args.includes("up") && process.env.FAKE_FAIL_UP !== undefined) {
  console.error("fake recreate failure");
  process.exit(Number(process.env.FAKE_FAIL_UP));
}
if (
  process.env.FAKE_HANG !== undefined &&
  args.includes(process.env.FAKE_HANG) &&
  (process.env.FAKE_HANG_WORKER === undefined ||
    args[args.indexOf("-p") + 1]?.endsWith(`-w${process.env.FAKE_HANG_WORKER}`))
) {
  const worker = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)",
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  appendFileSync(log, `${JSON.stringify({ worker: worker.pid })}\n`);
  // Keep the parent alive too, so cancellation must escalate and join it.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  worker.stdout.once("data", () => console.log("FAKE_RUNNING"));
  setInterval(() => {}, 1000);
} else if (args.includes("down") && process.env.FAKE_FAIL_DOWN !== undefined) {
  process.exit(Number(process.env.FAKE_FAIL_DOWN));
} else if (args.includes("run")) {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const scenarioId = value("--scenario");
  const model = value("--model-id");
  const channel = value("--channel");
  const dir = join(process.env.OPENCLAW_TEST_ARTIFACTS_DIR, value("--base-stamp"), "cells");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${model}-${scenarioId}-${channel}.json`),
    JSON.stringify({
      schemaVersion: 3,
      scenarioId,
      model,
      channel,
      iterationIndex: 1,
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
