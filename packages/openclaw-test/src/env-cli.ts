import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  discoverScenarios,
  expandChannelSelection,
  runMatrix,
  type WorkerContext,
  workerSpawnEnv,
} from "./loop.js";
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
                                   [--parallel K] [--stop-on-fail] [--reuse-stack]

  Scenario selection is required: either a positional list or --all (mutually exclusive).
  --model <id|id,id,…|all>
                      select the agent model(s): a bare id (e.g. claude-sonnet-4-6), a
                      comma list of bare ids, or "all". Defaults to OPENCLAW_DEFAULT_TEST_MODEL.
                      The catalog is OPENCLAW_TEST_MODELS (.env.local), a comma list of full
                      provider/model refs; the bare id is the suffix after the last "/".
                      "all" needs credentials for every selected provider.
  --iterations N      run each (scenario, channel) pair N times (default 1).
  --max-failures N    abort a pair once failures > N (default 1). Best-effort under
                      --parallel: in-flight cells of a bailed pair still finish.
  --parallel K        run up to K cells concurrently, each on its own worker stack
                      (Compose project <base>-w<i>). Defaults to OPENCLAW_TEST_PARALLEL
                      (.env.local), fallback 1. With K > 1, per-cell output is captured
                      to <artifacts>/<runStamp>/cells/<leaf>.log.
  --stop-on-fail      stop dispatching at the first failing cell (in-flight cells
                      drain) — pairs with --iterations to triage one bug at a time.
  --reuse-stack       skip the per-cell bus+gateway recreation (fastest path; but
                      scenarios leak state into each other with this option).

  The host owns the matrix: cells are dispatched to a pool of K worker stacks.
  Before a cell, a worker's bus and gateway are recreated (docker compose up -d
  --force-recreate --wait bus gateway) for fresh state; this also lazily creates
  a worker that isn't running yet. Each cell is one 'docker compose run --rm
  runner' invocation.

  Workers this run created are torn down at the end; already-running workers stay
  up. Run 'openclaw-test env up [--parallel K]' beforehand to keep workers warm
  across iterative runs.

  If the base image needs (re)building, every running <base>-w* worker stack is
  torn down first so the new image is picked up.`;

const ENV_USAGE = `usage: openclaw-test env <build|up|down>

  build               build the base and consumer images.
  up [--parallel K]   bring up worker stacks w1…wK warm (K defaults to
                      OPENCLAW_TEST_PARALLEL, fallback 1).
  down                tear down every <base>-w* worker stack, whatever K was.`;

export async function envCommand(packageDir: string, argv: string[]): Promise<never> {
  const [sub, ...rest] = argv;
  if (sub !== "build" && sub !== "up" && sub !== "down") failEnv();
  const parallelFlag = parseEnvArgs(sub, rest);
  setupHostEnv(packageDir);
  setBaseTag(packageDir);
  if (sub === "down") process.exit(sweepWorkerStacks());
  if (sub === "build") {
    ensureHostOutputDirs([]);
    ensureBaseImage(packageDir, { force: true });
    process.exit(execComposeSync(buildConsumerImageArgs(workerComposeArgs(1))));
  }
  const parallel = resolveParallel(parallelFlag, readEnvVar("OPENCLAW_TEST_PARALLEL"));
  const workers = buildWorkerContexts(parallel);
  ensureHostOutputDirs(workers);
  ensureBaseImage(packageDir, { force: false });
  ensureConsumerImage(workerComposeArgs(1));
  const configPath = renderRuntimeConfig(canonicalConfigPath());
  for (const worker of workers) refreshWorkerWorkspace(worker);
  const codes = await Promise.all(
    workers.map((worker) =>
      execCompose(
        [...worker.composeArgs, "up", "-d", "--wait", "--remove-orphans", "bus", "gateway"],
        workerSpawnEnv(worker, configPath),
      ),
    ),
  );
  process.exit(codes.find((code) => code !== 0) ?? 0);
}

export function buildConsumerImageArgs(composeArgs: string[]): string[] {
  return [...composeArgs, "build", "bus"];
}

export async function runCommand(packageDir: string, argv: string[]): Promise<never> {
  const args = parseRunArgs(argv);
  setupHostEnv(packageDir);
  const parallel = resolveParallel(args.parallel, readEnvVar("OPENCLAW_TEST_PARALLEL"));
  const models = resolveSelectedModels({
    selection: args.model,
    modelsEnv: readEnvVar("OPENCLAW_TEST_MODELS"),
    defaultEnv: readEnvVar("OPENCLAW_DEFAULT_TEST_MODEL"),
  });
  const canonicalPath = canonicalConfigPath();
  // Each model's config is rendered once (its own temp file holding the expanded
  // secret); worker loops hand the path to every spawn via per-spawn env.
  const renderedConfigs = new Map<string, string>();
  const renderConfigPath = (m: SelectedModel): string => {
    const cached = renderedConfigs.get(m.id);
    if (cached) return cached;
    const path = renderRuntimeConfig(canonicalPath, m);
    renderedConfigs.set(m.id, path);
    return path;
  };
  setBaseTag(packageDir);
  const didBuild = ensureBaseImage(packageDir, { force: false });
  // A fresh base image means any running worker stack is on a stale image. Sweep
  // them all so the lazy per-cell recreate boots them on the new image — and so
  // the auto-down at the end fires (wasRunningBefore is computed after the sweep).
  if (didBuild) {
    const sweepCode = sweepWorkerStacks();
    if (sweepCode !== 0) process.exit(sweepCode);
  }

  const scenariosDir = process.env.OPENCLAW_TEST_SCENARIOS_DIR as string;
  const artifactsDir = process.env.OPENCLAW_TEST_ARTIFACTS_DIR as string;

  // `--all` is alphabetical (discoverScenarios sorts); an explicit list keeps CLI
  // order, deduped.
  const scenarios = args.all ? discoverScenarios(scenariosDir) : [...new Set(args.positionals)];
  const channels = expandChannelSelection(args.channel, canonicalPath);

  const cellCount = models.length * scenarios.length * channels.length * args.iterations;
  const workers = buildWorkerContexts(Math.min(parallel, cellCount));
  ensureHostOutputDirs(workers);
  ensureConsumerImage(workerComposeArgs(1));

  const baseStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(artifactsDir, baseStamp, "cells");
  // The runner sees the artifacts dir bind-mounted at /opt/openclaw-test/artifacts (see docker-compose.yml).
  const runnerResultsDir = `/opt/openclaw-test/artifacts/${baseStamp}/cells`;
  mkdirSync(resultsDir, { recursive: true });

  const matrixExit = await runMatrix({
    scenarios,
    channels,
    models,
    renderConfigPath,
    iterations: args.iterations,
    maxFailures: args.maxFailures,
    stopOnFail: args.stopOnFail,
    reuseStack: args.reuseStack,
    parallel: workers.length,
    workers,
    refreshWorkspace: refreshWorkerWorkspace,
    artifactsDir: resolve(artifactsDir, baseStamp),
    resultsDir,
    runnerResultsDir,
    baseStamp,
  });

  const booted = workers.filter((worker) => !worker.wasRunningBefore);
  await Promise.all(booted.map((worker) => execCompose([...worker.composeArgs, "down"])));
  process.exit(matrixExit);
}

/** Flag wins over the env var; fallback 1. Both must parse to an integer ≥ 1. */
export function resolveParallel(flag: string | undefined, envValue: string | undefined): number {
  if (flag !== undefined) return parseParallelValue("--parallel", flag);
  if (envValue !== undefined) return parseParallelValue("OPENCLAW_TEST_PARALLEL", envValue);
  return 1;
}

function parseParallelValue(source: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`openclaw-test: ${source} expects an integer >= 1, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function canonicalConfigPath(): string {
  const path = process.env.OPENCLAW_CONFIG_PATH;
  if (!path) throw new Error("openclaw-test: OPENCLAW_CONFIG_PATH is unset");
  return path;
}

function buildWorkerContexts(count: number): WorkerContext[] {
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  const logsRoot = process.env.OPENCLAW_TEST_GATEWAY_LOGS_DIR as string;
  const contexts: WorkerContext[] = [];
  for (let i = 1; i <= count; ++i) {
    const composeArgs = workerComposeArgs(i);
    contexts.push({
      index: i,
      composeArgs,
      gatewayLogsDir: join(logsRoot, `w${i}`),
      workspaceDir: join(projectDir, ".workers", `w${i}`, "workspace"),
      wasRunningBefore: areBusAndGatewayRunning(composeArgs),
    });
  }
  return contexts;
}

function workerComposeArgs(index: number): string[] {
  return [...composeBaseArgs(), "-p", `${projectNameBase()}-w${index}`];
}

function projectNameBase(): string {
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  return sanitizeProjectName(basename(projectDir));
}

// Compose project-name rules: lowercase, [a-z0-9_-], must start alphanumeric.
function sanitizeProjectName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return sanitized === "" ? "openclaw-test" : sanitized;
}

function refreshWorkerWorkspace(worker: WorkerContext): void {
  const src = process.env.OPENCLAW_WORKSPACE_DIR;
  if (!src) throw new Error("openclaw-test: OPENCLAW_WORKSPACE_DIR is unset");
  rmSync(worker.workspaceDir, { recursive: true, force: true });
  cpSync(src, worker.workspaceDir, { recursive: true });
}

/** Tear down every `<base>-w<N>` Compose project, whatever K was. Idempotent. */
function sweepWorkerStacks(): number {
  let exitCode = 0;
  for (const name of listWorkerStackNames()) {
    const code = execComposeSync([...composeBaseArgs(), "-p", name, "down"]);
    if (code !== 0) exitCode = code;
  }
  return exitCode;
}

function listWorkerStackNames(): string[] {
  const r = spawnSync("docker", ["compose", "ls", "--all", "--format", "json"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  let projects: { Name?: string }[];
  try {
    projects = JSON.parse(r.stdout) as { Name?: string }[];
  } catch {
    return [];
  }
  // The sanitized base contains no regex metacharacters (only [a-z0-9_-]).
  const pattern = new RegExp(`^${projectNameBase()}-w\\d+$`);
  return projects
    .map((p) => p.Name)
    .filter((name): name is string => typeof name === "string" && pattern.test(name));
}

// Every service declares the same build and image. Target one representative service so Compose
// does not build bus, gateway and runner concurrently onto the shared tag.
function ensureConsumerImage(composeArgs: string[]): void {
  const image = process.env.OPENCLAW_TEST_CONSUMER_IMAGE as string;
  const inspect = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  if (inspect.status === 0) return;
  const code = execComposeSync(buildConsumerImageArgs(composeArgs));
  if (code !== 0) process.exit(code);
}

/**
 * OpenClaw has no native env interpolation in its config, so the harness expands
 * `${VAR}` itself. Walk the canonical config, replace any string value of the
 * exact form `${VAR}` with the value of `VAR` (process.env wins over `.env.local`),
 * and write the rendered JSON to a run-scoped temp dir so the expanded secret is
 * never persisted to a committed or artifact path. Returns the rendered path; the
 * canonical file is never mutated and `process.env` is never repointed — callers
 * pass the path to worker spawns via per-spawn env.
 *
 * When a `model` is given, `agents.list[id=main].model` is set to its full ref so
 * the gateway boots on the selected model. Rendered per model (own temp file).
 *
 * A `${VAR}` resolving to empty drops its enclosing `models.providers.*` entry so
 * a defined-but-unused provider with no key can't trip OpenClaw boot validation.
 */
function renderRuntimeConfig(canonicalPath: string, model?: SelectedModel): string {
  const projectDir = process.env.OPENCLAW_TEST_PROJECT_DIR ?? process.cwd();
  const dotenv = readDotenvFile(projectDir);
  const config = JSON.parse(readFileSync(canonicalPath, "utf8")) as Record<string, unknown>;
  const rendered = expandEnvRefs(config, dotenv) as Record<string, unknown>;
  const droppedProviders = dropProvidersMissingKey(rendered);
  if (model) {
    assertModelProviderPresent(model, droppedProviders);
    setMainAgentModel(rendered, model.ref);
  }
  const dir = mkdtempSync(join(tmpdir(), "openclaw-test-config-"));
  const renderedPath = join(dir, "openclaw.json");
  writeFileSync(renderedPath, JSON.stringify(rendered, null, 2));
  return renderedPath;
}

// A model's provider is the ref's first segment (`provider/model`); built-in
// providers (e.g. `anthropic`) aren't declared in config and never get dropped.
// Fail fast only when the selected model's provider was declared but dropped for
// an empty key — otherwise `setMainAgentModel` would point `main` at a missing
// provider and the gateway would boot-fail with an opaque error.
function assertModelProviderPresent(model: SelectedModel, droppedProviders: Set<string>): void {
  const provider = model.ref.split("/")[0];
  if (droppedProviders.has(provider)) {
    throw new Error(
      `openclaw-test: selected model "${model.ref}" needs provider "${provider}", but its API key expanded empty. Set the provider's API key in .env.local.`,
    );
  }
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
function dropProvidersMissingKey(config: Record<string, unknown>): Set<string> {
  const dropped = new Set<string>();
  const models = config.models;
  if (!models || typeof models !== "object") return dropped;
  const providers = (models as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object") return dropped;
  for (const [id, provider] of Object.entries(providers)) {
    if (
      provider &&
      typeof provider === "object" &&
      (provider as { apiKey?: unknown }).apiKey === ""
    ) {
      delete (providers as Record<string, unknown>)[id];
      dropped.add(id);
    }
  }
  return dropped;
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
  process.env.OPENCLAW_TEST_CONSUMER_IMAGE ??= `${sanitizeProjectName(basename(projectDir))}-openclaw-test:latest`;
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

// Pre-create the host-side output dirs (including each worker's gateway logs dir)
// as the current user, before any `docker compose up`. Otherwise the Docker
// daemon auto-creates a missing bind-mount source as root, which the container —
// running as the host UID — can then neither write nor let the user delete
// without sudo. Idempotent; safe to call on every command that brings a stack up.
function ensureHostOutputDirs(workers: WorkerContext[]): void {
  for (const key of ["OPENCLAW_TEST_ARTIFACTS_DIR", "OPENCLAW_TEST_GATEWAY_LOGS_DIR"] as const) {
    const dir = process.env[key];
    if (dir) mkdirSync(dir, { recursive: true });
  }
  for (const worker of workers) mkdirSync(worker.gatewayLogsDir, { recursive: true });
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

// The non-path vars (models, parallel) are never exported by setupHostEnv.
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

function execCompose(args: string[], env?: Record<string, string>): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn("docker", args, {
      stdio: "inherit",
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
    child.on("error", (err) => {
      console.error(err.message);
      resolveExit(1);
    });
  });
}

interface RunArgs {
  channel: string;
  model: string | undefined;
  iterations: number;
  maxFailures: number;
  parallel: string | undefined;
  stopOnFail: boolean;
  reuseStack: boolean;
  all: boolean;
  positionals: string[];
}

function requireFlagValue(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw.startsWith("--")) {
    failRun(`error: ${flag} expects a value`);
  }
  return raw;
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
  let parallel: string | undefined;
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
    else if (a === "--channel") channel = requireFlagValue("--channel", argv[++i]);
    else if (a?.startsWith("--channel=")) channel = a.slice("--channel=".length);
    else if (a === "--model") model = requireFlagValue("--model", argv[++i]);
    else if (a?.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--iterations") iterations = parseIntFlag("--iterations", argv[++i] ?? "", 1);
    else if (a?.startsWith("--iterations="))
      iterations = parseIntFlag("--iterations", a.slice("--iterations=".length), 1);
    else if (a === "--max-failures")
      maxFailures = parseIntFlag("--max-failures", argv[++i] ?? "", 0);
    else if (a?.startsWith("--max-failures="))
      maxFailures = parseIntFlag("--max-failures", a.slice("--max-failures=".length), 0);
    else if (a === "--parallel") parallel = requireFlagValue("--parallel", argv[++i]);
    else if (a?.startsWith("--parallel=")) parallel = a.slice("--parallel=".length);
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
    parallel,
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

/** Returns the raw `--parallel` value; only `env up` accepts it. */
function parseEnvArgs(sub: EnvSubcommand, rest: string[]): string | undefined {
  let parallel: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--parallel") {
      const raw = rest[++i];
      if (raw === undefined || raw.startsWith("--")) failEnv("error: --parallel expects a value");
      parallel = raw;
    } else if (a.startsWith("--parallel=")) parallel = a.slice("--parallel=".length);
    else failEnv(`error: unknown argument ${a}`);
  }
  if (parallel !== undefined && sub !== "up") {
    failEnv("error: --parallel is only valid on 'env up'");
  }
  return parallel;
}

function failEnv(msg?: string): never {
  if (msg) console.error(msg);
  console.error(ENV_USAGE);
  process.exit(1);
}
