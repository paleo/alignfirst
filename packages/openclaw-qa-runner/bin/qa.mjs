#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage: qa/bin/qa.mjs --channel <discord-mock|slack-mock|all> [<scenario> ...] [--all]
                    [--iterations N] [--max-failures N]

  Scenario selection is required: either a positional list or --all (mutually exclusive).
  --iterations N      run each (scenario, channel) pair N times (default 1).
  --max-failures N    abort a pair once failures > N (default 1).
  Run 'npm run env:up' first.`;

function fail(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(1);
}

let values;
let positionals;
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      channel: { type: "string" },
      iterations: { type: "string" },
      "max-failures": { type: "string" },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  }));
} catch (err) {
  fail(err.message);
}

if (values.help) fail();

const channel = values.channel;
if (channel !== "discord-mock" && channel !== "slack-mock" && channel !== "all") {
  fail("error: --channel must be discord-mock, slack-mock, or all");
}

if (values.all && positionals.length > 0) {
  fail("error: pass either --all or a positional scenario list, not both");
}
if (!values.all && positionals.length === 0) {
  fail("error: must pass --all or one or more scenario names");
}

const qaDir = process.env.QA_PROJECT_DIR || process.cwd();
const composeFile = resolve(qaDir, "docker-compose.yml");
const envFile = resolve(qaDir, ".env.local");

if (!process.env.CLAW_UID) process.env.CLAW_UID = String(process.getuid());
if (!process.env.CLAW_GID) process.env.CLAW_GID = String(process.getgid());
process.env.QA_PROJECT_DIR = qaDir;

const runnerArgs = ["--channel", channel];
if (values.iterations) runnerArgs.push("--iterations", values.iterations);
if (values["max-failures"]) runnerArgs.push("--max-failures", values["max-failures"]);
if (values.all) runnerArgs.push("--all");
else runnerArgs.push(...positionals);

const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    envFile,
    "-f",
    composeFile,
    "run",
    "--rm",
    "--use-aliases",
    "runner",
    ...runnerArgs,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
