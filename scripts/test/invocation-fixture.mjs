#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  invocationCommand,
  packageCommand,
  readLaunchEvidence,
  resolveInvocation,
} from "__INVOCATION_URL__";

const target = { packageName: "side20-invocation-probe", binaryName: "side20-invocation-probe" };
const fields = [
  "npm_command",
  "npm_config_user_agent",
  "npm_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_package_json",
];

if (process.argv.includes("nested")) {
  const child = spawnSync(process.execPath, [process.argv[1], "child"], {
    env: process.env,
    encoding: "utf8",
    timeout: 15_000,
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  process.exit(child.status ?? 1);
}

const evidence = readLaunchEvidence();
const invocation = resolveInvocation(target, evidence);
console.log(
  JSON.stringify({
    runtime: evidence.runtime,
    executable: evidence.executable,
    entryPoint: evidence.entryPoint,
    parentArgv: evidence.parentArgv,
    env: Object.fromEntries(fields.map((field) => [field, evidence.env[field]])),
    launcher: invocation.launcher,
    self: invocationCommand(invocation),
    counterpart: packageCommand(invocation, {
      packageName: "@alignfirst/docmap",
      binaryName: "docmap",
    }),
  }),
);
