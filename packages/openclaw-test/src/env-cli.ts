import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { discoverScenarios, expandChannelSelection, runMatrix } from "./loop.js";
import { resolveSelectedModels, type SelectedModel } from "./models.js";

// Path-shaped vars from .env.local: resolved against the consumer's project dir so users
// can write natural relative paths. Compose `include:` would otherwise resolve them
// against the package's compose file in node_modules/.
const PATH_VARS = [
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_TEST_SCENARIOS_DIR",
  "OPENCLAW_TEST_ARTIFACTS_DIR",
  "OPENCLAW_TEST_GATEWAY_LOGS_DIR",
] as const;

type EnvSubcommand = "build" | "up" | "down";

const RUN_USAGE = `usage: openclaw-test run --channel <id|id,id,…|all> [<scenario> ...] [--all]
                                   [--model <id|id,id,…|all>] [--iterations N] [--max-failures N]
                                   [--stop-on-fail] [--reuse-stack]

  Scenario selection is required: either a positional list or --all (mutually exclusive).
  --model <id|id,id,…|all>
                      select the agent model(s): a bare id (e.g. claude-sonnet-4-6), a
                      comma list of bare ids, or "all". Defaults to OPENCLAW_DEFAULT_TEST_MODEL.
                      The catalog is OPENCLAW_TEST_MODELS (.env.local), a comma list of full
                      provider/model refs; the bare id is the suffix after the last "/".
                      "all" (or any selected provider) needs that provider's API key.
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
  When auto-started, they are torn down after the run exits. Run 'openclaw-test env up'
  beforehand to keep them warm across iterative runs.

  If the base image needs (re)building, any already-running bus+gateway are
  torn down first so the new image is picked up.`;

const ENV_USAGE = "usage: openclaw-test env <build|up|down>";

export function envCommand(packageDir: string, argv: string[]): never {
  const sub = argv[0] as EnvSubcommand | undefined;
  if (sub !== "build" && sub !== "up" && sub !== "down") {
    console.error(ENV_USAGE);
    process.exit(1);
  }
  setupHostEnv(packageDir);
  if (sub === "up") renderRuntimeConfig();
  setBaseTag(packageDir);
  if (sub !== "down") {
    ensureHostOutputDirs();
    ensureBaseImage(packageDir, { force: sub === "build" });
  }
  const composeArgs = composeBaseArgs();
  const subArgs =
    sub === "build"
      ? ["build"]
      : sub === "up"
        ? ["up", "-d", "--wait", "--remove-orphans", "bus", "gateway"]
        : ["down"];
  process.exit(execComposeSync([...composeArgs, ...subArgs]));
}

export async function runCommand(packageDir: string, argv: string[]): Promise<never> {
  const { channel, model, iterations, maxFailures, stopOnFail, reuseStack, all, positionals } =
    parseRunArgs(argv);
  setupHostEnv(packageDir);
  const models = resolveSelectedModels({
    selection: model,
    modelsEnv: readEnvVar("OPENCLAW_TEST_MODELS"),
    defaultEnv: readEnvVar("OPENCLAW_DEFAULT_TEST_MODEL"),
  });
  // Render the first model's config before the initial `up`; the matrix's forced
  // model-boundary recreate handles every subsequent model.
  renderRuntimeConfig(models[0]);
  setBaseTag(packageDir);
  ensureHostOutputDirs();
  const didBuild = ensureBaseImage(packageDir, { force: false });

  const compose = composeBaseArgs();
  // A fresh base image means any running bus+gateway are on a stale image. Tear
  // them down so the up below recreates them — and so the auto-down at the end
  // fires (wereUpBefore is recomputed after the teardown).
  if (didBuild && areBusAndGatewayRunning(compose)) {
    const downCode = execComposeSync([...compose, "down"]);
    if (downCode !== 0) process.exit(downCode);
  }
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

  const scenariosDir = process.env.OPENCLAW_TEST_SCENARIOS_DIR as string;
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH as string;
  const artifactsDir = process.env.OPENCLAW_TEST_ARTIFACTS_DIR as string;

  const scenarios = all ? discoverScenarios(scenariosDir) : positionals;
  const channels = expandChannelSelection(channel, openclawConfigPath);

  const baseStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(artifactsDir, baseStamp, "cells");
  // The runner sees the artifacts dir bind-mounted at /opt/openclaw-test/artifacts (see docker-compose.yml).
  const runnerResultsDir = `/opt/openclaw-test/artifacts/${baseStamp}/cells`;
  mkdirSync(resultsDir, { recursive: true });

  const matrixExit = await runMatrix({
    scenarios,
    channels,
    models,
    renderConfigPath: (m) => {
      const path = renderRuntimeConfig(m);
      if (!path) throw new Error("openclaw-test: OPENCLAW_CONFIG_PATH is unset");
      return path;
    },
    iterations,
    maxFailures,
    stopOnFail,
    reuseStack,
    skipFirstRestart: !wereUpBefore && !reuseStack,
    composeArgs: compose,
    artifactsDir: resolve(artifactsDir, baseStamp),
    gatewayLogsDir: process.env.OPENCLAW_TEST_GATEWAY_LOGS_DIR as string,
    resultsDir,
    runnerResultsDir,
    baseStamp,
  });

  if (!wereUpBefore) {
    execComposeSync([...compose, "down"]);
  }
  process.exit(matrixExit);
}

/**
 * OpenClaw has no native env interpolation in its config, so the harness expands
 * `${VAR}` itself. Walk the canonical config, replace any string value of the
 * exact form `${VAR}` with the value of `VAR` (process.env wins over `.env.local`),
 * and write the rendered JSON to a run-scoped temp dir so the expanded secret is
 * never persisted to a committed or artifact path. Returns the rendered path and
 * repoints `OPENCLAW_CONFIG_PATH` at it; the canonical file is never mutated.
 *
 * When a `model` is given, `agents.list[id=main].model` is set to its full ref so
 * the gateway boots on the selected model. Rendered per model (own temp file).
 *
 * A `${VAR}` resolving to empty drops its enclosing `models.providers.*` entry so
 * a defined-but-unused provider with no key can't trip OpenClaw boot validation.
 */
function renderRuntimeConfig(model?: SelectedModel): string | undefined {
  const canonicalPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!canonicalPath) return;
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  const dotenv = readDotenvFile(projectDir);
  const config = JSON.parse(readFileSync(canonicalPath, "utf8")) as Record<string, unknown>;
  const rendered = expandEnvRefs(config, dotenv) as Record<string, unknown>;
  dropProvidersMissingKey(rendered);
  if (model) setMainAgentModel(rendered, model.ref);
  const dir = mkdtempSync(join(tmpdir(), "openclaw-test-config-"));
  const renderedPath = join(dir, "openclaw.json");
  writeFileSync(renderedPath, JSON.stringify(rendered, null, 2));
  process.env.OPENCLAW_CONFIG_PATH = renderedPath;
  return renderedPath;
}

function setMainAgentModel(config: Record<string, unknown>, ref: string): void {
  const agents = config.agents;
  const list =
    agents && typeof agents === "object" ? (agents as { list?: unknown }).list : undefined;
  if (!Array.isArray(list)) throw new Error("openclaw-test: config has no agents.list array");
  const main = list.find(
    (a): a is Record<string, unknown> =>
      !!a && typeof a === "object" && (a as { id?: unknown }).id === "main",
  );
  if (!main) throw new Error("openclaw-test: config has no agents.list entry with id 'main'");
  main.model = ref;
}

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function expandEnvRefs(value: unknown, dotenv: Record<string, string>): unknown {
  if (typeof value === "string") {
    const m = value.match(ENV_REF);
    if (!m) return value;
    const name = m[1];
    const resolved = process.env[name] ?? dotenv[name];
    if (resolved === undefined) {
      console.warn(`openclaw-test: config references unset env var ${name}; expanding to ""`);
      return "";
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvRefs(v, dotenv));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnvRefs(v, dotenv);
    return out;
  }
  return value;
}

// On the rendered config, an empty `apiKey` means its `${VAR}` reference expanded
// to an unset value. Drop the whole provider so boot validation for a
// defined-but-unused provider can't fail on the empty key.
function dropProvidersMissingKey(config: Record<string, unknown>): void {
  const models = config.models;
  if (!models || typeof models !== "object") return;
  const providers = (models as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object") return;
  for (const [id, provider] of Object.entries(providers)) {
    if (
      provider &&
      typeof provider === "object" &&
      (provider as { apiKey?: unknown }).apiKey === ""
    ) {
      delete (providers as Record<string, unknown>)[id];
    }
  }
}

const BASE_IMAGE_NAME = "paleo/openclaw-test-base";

function setBaseTag(packageDir: string): void {
  process.env.OPENCLAW_TEST_BASE_TAG = readPackageVersion(packageDir);
}

// Build (or reuse) the consumer-agnostic base image. Tagged with the openclaw-test
// package version so consumer Dockerfiles can pin via the OPENCLAW_TEST_BASE_TAG
// build arg. `force` always rebuilds — Docker's layer cache makes no-op
// rebuilds near-free, so we skip the inspect dance on `env build`.
function ensureBaseImage(packageDir: string, opts: { force: boolean }): boolean {
  const tag = `${BASE_IMAGE_NAME}:${process.env.OPENCLAW_TEST_BASE_TAG}`;
  if (!opts.force) {
    const inspect = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    if (inspect.status === 0) return false;
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
  return true;
}

function readPackageVersion(packageDir: string): string {
  const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!pkg.version) {
    console.error("openclaw-test: package.json is missing 'version'");
    process.exit(1);
  }
  return pkg.version;
}

function setupHostEnv(packageDir: string): void {
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  process.env.OPENCLAW_TEST_PROJECT_DIR = projectDir;
  process.env.OPENCLAW_TEST_PACKAGE_DIR ??= packageDir;
  if (!process.env.CLAW_UID) process.env.CLAW_UID = String(process.getuid?.() ?? 1000);
  if (!process.env.CLAW_GID) process.env.CLAW_GID = String(process.getgid?.() ?? 1000);
  absolutizePathVarsFromEnvFile(projectDir);
  applyPathDefaults(projectDir);
}

// Defaults relative to the consumer's project dir, applied after `.env.local` so
// explicit values win. Doing this in the CLI (not via `${VAR:-default}` in
// docker-compose.yml) avoids nested Compose interpolation, which is fragile
// across versions and not portable across Compose implementations.
const PATH_DEFAULTS: Record<string, string> = {
  OPENCLAW_CONFIG_PATH: "openclaw.json",
  OPENCLAW_TEST_SCENARIOS_DIR: "scenarios",
  OPENCLAW_TEST_ARTIFACTS_DIR: "artifacts",
  OPENCLAW_TEST_GATEWAY_LOGS_DIR: ".gateway-logs",
};

function applyPathDefaults(projectDir: string): void {
  for (const [key, rel] of Object.entries(PATH_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = resolve(projectDir, rel);
  }
}

// Pre-create the host-side output dirs as the current user, before any
// `docker compose up`. Otherwise the Docker daemon auto-creates a missing
// bind-mount source (notably `.gateway-logs`) as root, which the container —
// running as the host UID — can then neither write nor let the user delete
// without sudo. Idempotent; safe to call on every command that brings the stack up.
function ensureHostOutputDirs(): void {
  for (const key of ["OPENCLAW_TEST_ARTIFACTS_DIR", "OPENCLAW_TEST_GATEWAY_LOGS_DIR"] as const) {
    const dir = process.env[key];
    if (dir) mkdirSync(dir, { recursive: true });
  }
}

/**
 * Absolutize path vars from `.env.local` against the consumer's project dir.
 *
 * Compose `include:` resolves relative bind-mount paths against the declaring
 * file (here, `node_modules/@paleo/openclaw-test/`), not the consumer's
 * project dir. Exporting absolute paths via `process.env` sidesteps that.
 */
function absolutizePathVarsFromEnvFile(projectDir: string): void {
  const parsed = readDotenvFile(projectDir);
  for (const key of PATH_VARS) {
    // Shell env already wins over --env-file; only act when .env.local supplies a relative path.
    if (process.env[key]) continue;
    const raw = parsed[key];
    if (!raw) continue;
    process.env[key] = isAbsolute(raw) ? raw : resolve(projectDir, raw);
  }
}

// The two model vars are not path-shaped, so setupHostEnv never exports them.
// Read the shell env first (wins over --env-file), then fall back to .env.local.
function readEnvVar(key: string): string | undefined {
  const fromShell = process.env[key];
  if (fromShell !== undefined && fromShell !== "") return fromShell;
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  const fromFile = readDotenvFile(projectDir)[key];
  return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
}

function readDotenvFile(projectDir: string): Record<string, string> {
  const envFile = resolve(projectDir, ".env.local");
  if (!existsSync(envFile)) return {};
  return parseDotenv(readFileSync(envFile, "utf8"));
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
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  const composeFile = resolve(projectDir, "docker-compose.yml");
  const envFile = resolve(projectDir, ".env.local");
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

interface RunArgs {
  channel: string;
  model: string | undefined;
  iterations: number;
  maxFailures: number;
  stopOnFail: boolean;
  reuseStack: boolean;
  all: boolean;
  positionals: string[];
}

function parseIntFlag(flag: string, raw: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    failRun(`error: ${flag} expects an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseRunArgs(argv: string[]): RunArgs {
  let channel: string | undefined;
  let model: string | undefined;
  let iterations = 1;
  let maxFailures = 1;
  let stopOnFail = false;
  let reuseStack = false;
  let all = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") failRun();
    else if (a === "--all") all = true;
    else if (a === "--reuse-stack") reuseStack = true;
    else if (a === "--stop-on-fail") stopOnFail = true;
    else if (a === "--channel") channel = argv[++i];
    else if (a?.startsWith("--channel=")) channel = a.slice("--channel=".length);
    else if (a === "--model") model = argv[++i];
    else if (a?.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--iterations") iterations = parseIntFlag("--iterations", argv[++i] ?? "", 1);
    else if (a?.startsWith("--iterations="))
      iterations = parseIntFlag("--iterations", a.slice("--iterations=".length), 1);
    else if (a === "--max-failures")
      maxFailures = parseIntFlag("--max-failures", argv[++i] ?? "", 0);
    else if (a?.startsWith("--max-failures="))
      maxFailures = parseIntFlag("--max-failures", a.slice("--max-failures=".length), 0);
    else if (a?.startsWith("--")) failRun(`error: unknown flag ${a}`);
    else if (a) positionals.push(a);
  }

  if (!channel || channel.length === 0) failRun("error: --channel is required");
  if (all && positionals.length > 0)
    failRun("error: pass either --all or a positional scenario list, not both");
  if (!all && positionals.length === 0)
    failRun("error: must pass --all or one or more scenario names");

  return {
    channel: channel as string,
    model,
    iterations,
    maxFailures,
    stopOnFail,
    reuseStack,
    all,
    positionals,
  };
}

function failRun(msg?: string): never {
  if (msg) console.error(msg);
  console.error(RUN_USAGE);
  process.exit(1);
}
