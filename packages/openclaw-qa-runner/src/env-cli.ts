import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { discoverScenarios, expandChannelSelection, runMatrix } from "./qa-loop.js";

// Path-shaped vars from .env.local: resolved against the consumer's qa/ dir so users
// can write natural relative paths. Compose `include:` would otherwise resolve them
// against the package's compose file in node_modules/.
const PATH_VARS = [
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "QA_SCENARIOS_DIR",
  "QA_ARTIFACTS_DIR",
  "QA_GATEWAY_LOGS_DIR",
] as const;

type EnvSubcommand = "build" | "up" | "down";

const QA_USAGE = `usage: openclaw-qa-runner qa --channel <id|id,id,…|all> [<scenario> ...] [--all]
                                  [--iterations N] [--max-failures N] [--stop-on-fail] [--reuse-stack]

  Scenario selection is required: either a positional list or --all (mutually exclusive).
  --iterations N      run each (scenario, channel) pair N times (default 1).
  --max-failures N    abort a pair once failures > N (default 1).
  --stop-on-fail      stop the whole matrix at the first failing cell — pairs with
                      --iterations to triage one bug at a time before retrying.
  --reuse-stack       skip the per-cell bus+gateway recreation (fastest path; but
                      scenarios leak state into each other with this option).

  The host owns the matrix loop: between cells it recreates the bus and gateway
  containers (docker compose up -d --force-recreate --wait bus gateway) for fresh
  state. Each cell is one 'docker compose run --rm runner' invocation.

  bus + gateway are auto-started via Docker Compose if not already running.
  When auto-started, they are torn down after qa exits. Run 'openclaw-qa-runner env up'
  beforehand to keep them warm across iterative runs.`;

const ENV_USAGE = "usage: openclaw-qa-runner env <build|up|down>";

export function envCommand(packageDir: string, argv: string[]): never {
  const sub = argv[0] as EnvSubcommand | undefined;
  if (sub !== "build" && sub !== "up" && sub !== "down") {
    console.error(ENV_USAGE);
    process.exit(1);
  }
  setupHostEnv(packageDir);
  setBaseTag(packageDir);
  if (sub !== "down") ensureBaseImage(packageDir, { force: sub === "build" });
  const composeArgs = composeBaseArgs();
  const subArgs =
    sub === "build"
      ? ["build"]
      : sub === "up"
        ? ["up", "-d", "--wait", "--remove-orphans", "bus", "gateway"]
        : ["down"];
  process.exit(execComposeSync([...composeArgs, ...subArgs]));
}

export async function qaCommand(packageDir: string, argv: string[]): Promise<never> {
  const { channel, iterations, maxFailures, stopOnFail, reuseStack, all, positionals } =
    parseQaArgs(argv);
  setupHostEnv(packageDir);
  setBaseTag(packageDir);
  ensureBaseImage(packageDir, { force: false });

  const compose = composeBaseArgs();
  const wereUpBefore = areBusAndGatewayRunning(compose);
  if (!wereUpBefore) {
    const upCode = execComposeSync([
      ...compose,
      "up",
      "-d",
      "--wait",
      "--remove-orphans",
      "bus",
      "gateway",
    ]);
    if (upCode !== 0) process.exit(upCode);
  }

  const scenariosDir = process.env.QA_SCENARIOS_DIR as string;
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH as string;
  const artifactsDir = process.env.QA_ARTIFACTS_DIR as string;

  const scenarios = all ? discoverScenarios(scenariosDir) : positionals;
  const channels = expandChannelSelection(channel, openclawConfigPath);

  const baseStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(artifactsDir, baseStamp, "cells");
  // The runner sees the artifacts dir bind-mounted at /opt/qa-artifacts (see docker-compose.yml).
  const runnerResultsDir = `/opt/qa-artifacts/${baseStamp}/cells`;
  mkdirSync(resultsDir, { recursive: true });

  const matrixExit = await runMatrix({
    scenarios,
    channels,
    iterations: iterations ? Number(iterations) : 1,
    maxFailures: maxFailures ? Number(maxFailures) : 1,
    stopOnFail,
    reuseStack,
    skipFirstRestart: !wereUpBefore && !reuseStack,
    composeArgs: compose,
    artifactsDir: resolve(artifactsDir, baseStamp),
    gatewayLogsDir: process.env.QA_GATEWAY_LOGS_DIR as string,
    resultsDir,
    runnerResultsDir,
    baseStamp,
  });

  if (!wereUpBefore) {
    execComposeSync([...compose, "down"]);
  }
  process.exit(matrixExit);
}

const BASE_IMAGE_NAME = "paleo/openclaw-qa-runner-base";

function setBaseTag(packageDir: string): void {
  process.env.QA_RUNNER_BASE_TAG = readPackageVersion(packageDir);
}

// Build (or reuse) the consumer-agnostic base image. Tagged with the qa-runner
// package version so consumer Dockerfiles can pin via the QA_RUNNER_BASE_TAG
// build arg. `force` always rebuilds — Docker's layer cache makes no-op
// rebuilds near-free, so we skip the inspect dance on `env build`.
function ensureBaseImage(packageDir: string, opts: { force: boolean }): void {
  const tag = `${BASE_IMAGE_NAME}:${process.env.QA_RUNNER_BASE_TAG}`;
  if (!opts.force) {
    const inspect = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    if (inspect.status === 0) return;
  }
  const dockerfile = resolve(packageDir, "Dockerfile.base");
  const args = [
    "build",
    "-f",
    dockerfile,
    "-t",
    tag,
    "--build-arg",
    `CLAW_UID=${process.env.CLAW_UID}`,
    "--build-arg",
    `CLAW_GID=${process.env.CLAW_GID}`,
    packageDir,
  ];
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`base image build failed (tag ${tag})`);
    process.exit(r.status ?? 1);
  }
}

function readPackageVersion(packageDir: string): string {
  const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!pkg.version) {
    console.error("openclaw-qa-runner: package.json is missing 'version'");
    process.exit(1);
  }
  return pkg.version;
}

function setupHostEnv(packageDir: string): void {
  const qaDir = process.env.QA_PROJECT_DIR ?? process.cwd();
  process.env.QA_PROJECT_DIR = qaDir;
  process.env.QA_RUNNER_PACKAGE_DIR ??= packageDir;
  if (!process.env.CLAW_UID) process.env.CLAW_UID = String(process.getuid?.() ?? 1000);
  if (!process.env.CLAW_GID) process.env.CLAW_GID = String(process.getgid?.() ?? 1000);
  absolutizePathVarsFromEnvFile(qaDir);
  applyPathDefaults(qaDir);
}

// Defaults relative to the consumer's qa dir, applied after `.env.local` so
// explicit values win. Doing this in the CLI (not via `${VAR:-default}` in
// docker-compose.yml) avoids nested Compose interpolation, which is fragile
// across versions and not portable across Compose implementations.
const PATH_DEFAULTS: Record<string, string> = {
  OPENCLAW_CONFIG_PATH: "openclaw.json",
  QA_SCENARIOS_DIR: "scenarios",
  QA_ARTIFACTS_DIR: "artifacts",
  QA_GATEWAY_LOGS_DIR: ".gateway-logs",
};

function applyPathDefaults(qaDir: string): void {
  for (const [key, rel] of Object.entries(PATH_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = resolve(qaDir, rel);
  }
}

/**
 * Absolutize path vars from `.env.local` against the consumer's qa dir.
 *
 * Compose `include:` resolves relative bind-mount paths against the declaring
 * file (here, `node_modules/@paleo/openclaw-qa-runner/`), not the consumer's
 * qa dir. Exporting absolute paths via `process.env` sidesteps that.
 */
function absolutizePathVarsFromEnvFile(qaDir: string): void {
  const envFile = resolve(qaDir, ".env.local");
  if (!existsSync(envFile)) return;
  const parsed = parseDotenv(readFileSync(envFile, "utf8"));
  for (const key of PATH_VARS) {
    // Shell env already wins over --env-file; only act when .env.local supplies a relative path.
    if (process.env[key]) continue;
    const raw = parsed[key];
    if (!raw) continue;
    process.env[key] = isAbsolute(raw) ? raw : resolve(qaDir, raw);
  }
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function composeBaseArgs(): string[] {
  const qaDir = process.env.QA_PROJECT_DIR ?? process.cwd();
  const composeFile = resolve(qaDir, "docker-compose.yml");
  const envFile = resolve(qaDir, ".env.local");
  const args = ["compose"];
  if (existsSync(envFile)) args.push("--env-file", envFile);
  args.push("-f", composeFile);
  return args;
}

function areBusAndGatewayRunning(composeArgs: string[]): boolean {
  const r = spawnSync(
    "docker",
    [...composeArgs, "ps", "--services", "--filter", "status=running"],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) return false;
  const services = new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return services.has("bus") && services.has("gateway");
}

function execComposeSync(args: string[]): number {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

interface QaArgs {
  channel: string;
  iterations?: string;
  maxFailures?: string;
  stopOnFail: boolean;
  reuseStack: boolean;
  all: boolean;
  positionals: string[];
}

function parseQaArgs(argv: string[]): QaArgs {
  let channel: string | undefined;
  let iterations: string | undefined;
  let maxFailures: string | undefined;
  let stopOnFail = false;
  let reuseStack = false;
  let all = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") failQa();
    else if (a === "--all") all = true;
    else if (a === "--reuse-stack") reuseStack = true;
    else if (a === "--stop-on-fail") stopOnFail = true;
    else if (a === "--channel") channel = argv[++i];
    else if (a?.startsWith("--channel=")) channel = a.slice("--channel=".length);
    else if (a === "--iterations") iterations = argv[++i];
    else if (a?.startsWith("--iterations=")) iterations = a.slice("--iterations=".length);
    else if (a === "--max-failures") maxFailures = argv[++i];
    else if (a?.startsWith("--max-failures=")) maxFailures = a.slice("--max-failures=".length);
    else if (a?.startsWith("--")) failQa(`error: unknown flag ${a}`);
    else if (a) positionals.push(a);
  }

  if (!channel || channel.length === 0) failQa("error: --channel is required");
  if (all && positionals.length > 0)
    failQa("error: pass either --all or a positional scenario list, not both");
  if (!all && positionals.length === 0)
    failQa("error: must pass --all or one or more scenario names");

  return {
    channel: channel as string,
    iterations,
    maxFailures,
    stopOnFail,
    reuseStack,
    all,
    positionals,
  };
}

function failQa(msg?: string): never {
  if (msg) console.error(msg);
  console.error(QA_USAGE);
  process.exit(1);
}
