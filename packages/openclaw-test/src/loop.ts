import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { type CellResult, cellLeafName, readCellResult } from "./cell-result.js";
import { judgeCostUsd } from "./cost.js";
import type { SelectedModel } from "./models.js";
import { printSummary, printTotalCost } from "./summary.js";

export function expandChannelSelection(raw: string, openclawConfigPath: string): string[] {
  if (!raw) throw new Error("run: --channel expects a non-empty value");
  const cfg = JSON.parse(readFileSync(openclawConfigPath, "utf8")) as {
    channels?: Record<string, unknown>;
  };
  const allowed = Object.keys(cfg.channels ?? {});
  if (allowed.length === 0) throw new Error(`no channels declared in ${openclawConfigPath}`);
  if (raw === "all") return [...allowed].sort();
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(`run: --channel expects a non-empty list, got ${JSON.stringify(raw)}`);
  }
  const unknown = ids.filter((c) => !allowed.includes(c));
  if (unknown.length > 0) {
    throw new Error(`unknown channel(s): ${unknown.join(", ")} — allowed: ${allowed.join(", ")}`);
  }
  return [...new Set(ids)];
}

export function discoverScenarios(scenariosDir: string): string[] {
  return readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -".ts".length))
    .sort();
}

export interface MatrixOptions {
  scenarios: string[];
  channels: string[];
  models: SelectedModel[];
  /**
   * Renders the chosen model's ref into a run-scoped config and returns its path
   * (memoized per model). Worker loops hand it to every spawn via per-spawn env.
   */
  renderConfigPath: (model: SelectedModel) => string;
  iterations: number;
  maxFailures: number;
  /** Stop dispatching at the first failing cell; in-flight cells drain. */
  stopOnFail: boolean;
  reuseStack: boolean;
  /** Pool size; a serial run is a pool of 1 (inherited stdio, no status lines). */
  parallel: number;
  workers: WorkerContext[];
  /** Refresh the worker's private workspace copy; called before every cell. */
  refreshWorkspace: (worker: WorkerContext) => void;
  artifactsDir: string;
  /** Host-side path to the results dir; the host reads `*.json` from here. */
  resultsDir: string;
  /** Container-side path passed to the runner via `--results-dir`. */
  runnerResultsDir: string;
  baseStamp: string;
  spawnRunner?: SpawnFn;
  spawnRecreate?: SpawnFn;
  readResult?: (path: string) => CellResult | undefined;
}

export interface WorkerContext {
  /** 1-based. */
  index: number;
  /** Compose base args + `["-p", "<base>-w<i>"]`. */
  composeArgs: string[];
  /** Host-side per-worker gateway logs dir, bind-mounted into the worker's gateway. */
  gatewayLogsDir: string;
  /** Host-side per-worker workspace copy, bind-mounted into the worker's gateway. */
  workspaceDir: string;
  /** True when the worker's bus+gateway were already running before this command. */
  wasRunningBefore: boolean;
}

export type SpawnFn = (args: SpawnRequest) => Promise<number>;

export interface SpawnRequest {
  command: string;
  argv: string[];
  /** Extra env merged over `process.env` for this spawn only. */
  env?: Record<string, string>;
  /** When set, stdout+stderr are appended to this file instead of inherited. */
  logFile?: string;
  onChild?: (child: ChildProcess) => void;
}

/**
 * Per-worker env for a compose spawn. Compose re-interpolates bind mounts on
 * every invocation, so recreate, `run runner` and `up` must all carry it.
 */
export function workerSpawnEnv(worker: WorkerContext, configPath: string): Record<string, string> {
  return {
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_TEST_GATEWAY_LOGS_DIR: worker.gatewayLogsDir,
    OPENCLAW_WORKSPACE_DIR: worker.workspaceDir,
  };
}

export async function runMatrix(opts: MatrixOptions): Promise<number> {
  const state: SchedulerState = {
    pending: expandCells(opts),
    runningPerModel: new Map(),
    pairFailures: new Map(),
    bailedPairs: new Set(),
    stopped: false,
    signalled: false,
    liveChildren: new Set(),
    records: [],
    exitCode: 0,
  };
  const ctx: WorkerLoopContext = {
    opts,
    state,
    spawnRunner: opts.spawnRunner ?? defaultSpawn,
    spawnRecreate: opts.spawnRecreate ?? defaultSpawn,
    readResult: opts.readResult ?? readCellResult,
    iterationWidth: opts.iterations > 1 ? String(opts.iterations).length : 0,
  };

  const onSignal = (sig: NodeJS.Signals) => {
    state.stopped = true;
    state.signalled = true;
    for (const child of state.liveChildren) child.kill(sig);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await Promise.all(opts.workers.map((worker) => workerLoop(ctx, worker)));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const results = [...state.records]
    .sort((a, b) => a.cell.index - b.cell.index)
    .map((r) => r.result);
  printSummary(results, opts.baseStamp);
  printTotalCost(results);

  if (state.exitCode !== 0) return state.exitCode;
  return results.some((r) => r.verdict === "fail") ? 1 : 0;
}

interface Cell {
  /** Expansion order, for deterministic summary sorting. */
  index: number;
  model: SelectedModel;
  scenario: string;
  channel: string;
  iteration: number;
  /** `${model.id}|${scenario}|${channel}` — the `--max-failures` bail unit. */
  pairKey: string;
}

interface SchedulerState {
  pending: Cell[];
  /** Cells currently running, per model id — drives the model-spread dispatch. */
  runningPerModel: Map<string, number>;
  pairFailures: Map<string, number>;
  bailedPairs: Set<string>;
  /** No further dispatch; in-flight cells drain (unless killed by a signal). */
  stopped: boolean;
  signalled: boolean;
  liveChildren: Set<ChildProcess>;
  records: { cell: Cell; result: CellResult }[];
  /** A nonzero recreate exit wins over the fail-derived exit code. */
  exitCode: number;
}

interface WorkerLoopContext {
  opts: MatrixOptions;
  state: SchedulerState;
  spawnRunner: SpawnFn;
  spawnRecreate: SpawnFn;
  readResult: (path: string) => CellResult | undefined;
  iterationWidth: number;
}

/** Full expansion in `model × scenario × channel × iteration` nesting order. */
function expandCells(opts: MatrixOptions): Cell[] {
  const cells: Cell[] = [];
  for (const model of opts.models) {
    for (const scenario of opts.scenarios) {
      for (const channel of opts.channels) {
        for (let iter = 1; iter <= opts.iterations; ++iter) {
          cells.push({
            index: cells.length,
            model,
            scenario,
            channel,
            iteration: iter,
            pairKey: `${model.id}|${scenario}|${channel}`,
          });
        }
      }
    }
  }
  return cells;
}

async function workerLoop(ctx: WorkerLoopContext, worker: WorkerContext): Promise<void> {
  const { opts, state } = ctx;
  const liveTrajectoryDir = join(worker.gatewayLogsDir, "trajectory");
  archiveLeftoverTrajectory(liveTrajectoryDir, opts.artifactsDir);
  // The model the worker's gateway booted on. Workers are created lazily: the
  // first cell's `up -d --force-recreate` also creates a stack that isn't running.
  let loadedModelId: string | undefined;
  for (;;) {
    const cell = takeNextCell(state, opts.reuseStack ? loadedModelId : undefined);
    if (!cell) return;
    changeRunningCount(state, cell.model.id, 1);
    try {
      const recreated = await runCell(ctx, worker, cell, loadedModelId, liveTrajectoryDir);
      if (recreated) loadedModelId = cell.model.id;
    } finally {
      changeRunningCount(state, cell.model.id, -1);
    }
  }
}

/**
 * Skip bailed pairs. Under `--reuse-stack` (`loadedModelId` given), first look for
 * a pending cell matching the loaded model to avoid the recreate; otherwise pick
 * the pending cell whose model has the fewest running cells (spreads providers,
 * softens rate-limit bursts; tie → expansion order).
 */
function takeNextCell(state: SchedulerState, loadedModelId: string | undefined): Cell | undefined {
  if (state.stopped) return;
  state.pending = state.pending.filter((c) => !state.bailedPairs.has(c.pairKey));
  if (state.pending.length === 0) return;
  const affinity =
    loadedModelId !== undefined
      ? state.pending.find((c) => c.model.id === loadedModelId)
      : undefined;
  const cell = affinity ?? leastLoadedModelCell(state);
  state.pending.splice(state.pending.indexOf(cell), 1);
  return cell;
}

// Linear scan is fine: `pending` is small and shrinks per take.
function leastLoadedModelCell(state: SchedulerState): Cell {
  let best = state.pending[0];
  let bestCount = state.runningPerModel.get(best.model.id) ?? 0;
  for (const cell of state.pending) {
    const count = state.runningPerModel.get(cell.model.id) ?? 0;
    if (count < bestCount) {
      best = cell;
      bestCount = count;
    }
  }
  return best;
}

function changeRunningCount(state: SchedulerState, modelId: string, delta: number): void {
  state.runningPerModel.set(modelId, (state.runningPerModel.get(modelId) ?? 0) + delta);
}

/** Returns true when the worker's stack was (re)created for this cell. */
async function runCell(
  ctx: WorkerLoopContext,
  worker: WorkerContext,
  cell: Cell,
  loadedModelId: string | undefined,
  liveTrajectoryDir: string,
): Promise<boolean> {
  const { opts, state } = ctx;
  const leaf = cellLeafName({
    scenarioId: cell.scenario,
    modelId: cell.model.id,
    channel: cell.channel,
    iterationIndex: cell.iteration,
    iterationWidth: ctx.iterationWidth,
  });
  const env = workerSpawnEnv(worker, opts.renderConfigPath(cell.model));
  const logFile = opts.parallel > 1 ? join(opts.resultsDir, `${leaf}.log`) : undefined;
  if (opts.parallel > 1) console.log(`[w${worker.index}] ${leaf} started`);

  // Refresh even on the reuse-stack no-recreate path: the live gateway reads the
  // workspace lazily, so this is intentional despite the reuse-stack state-leak caveat.
  opts.refreshWorkspace(worker);

  const needRecreate = !opts.reuseStack || loadedModelId !== cell.model.id;
  if (needRecreate) {
    const code = await spawnTracked(ctx.spawnRecreate, state, {
      command: "docker",
      argv: [...worker.composeArgs, "up", "-d", "--force-recreate", "--wait", "bus", "gateway"],
      env,
      logFile,
    });
    if (state.signalled) return false;
    if (code !== 0) {
      state.stopped = true;
      state.exitCode = code;
      if (opts.parallel > 1) {
        console.error(`[w${worker.index}] ${leaf} bus+gateway recreate failed (exit ${code})`);
      }
      return false;
    }
  }

  const resultsPath = join(opts.resultsDir, `${leaf}.json`);
  const childExit = await spawnTracked(ctx.spawnRunner, state, {
    command: "docker",
    argv: [
      ...worker.composeArgs,
      "run",
      "--rm",
      "--use-aliases",
      "runner",
      "--scenario",
      cell.scenario,
      "--channel",
      cell.channel,
      "--model-id",
      cell.model.id,
      "--model-ref",
      cell.model.ref,
      "--iteration-index",
      String(cell.iteration),
      "--iteration-width",
      String(ctx.iterationWidth),
      "--base-stamp",
      opts.baseStamp,
      "--results-dir",
      opts.runnerResultsDir,
    ],
    env,
    logFile,
  });

  const result =
    ctx.readResult(resultsPath) ??
    synthesizeFailedResult({
      scenario: cell.scenario,
      channel: cell.channel,
      model: cell.model.id,
      iter: cell.iteration,
      resultsPath,
      childExit,
    });
  state.records.push({ cell, result });

  rotateTrajectory({
    liveTrajectoryDir,
    artifactsDir: opts.artifactsDir,
    cellDirName: result.artifactDirName,
    fallbackDir: join(opts.resultsDir, `${leaf}.trajectory`),
  });

  if (opts.parallel > 1) console.log(formatCellDone(worker.index, leaf, result));
  if (result.verdict === "fail") {
    if (opts.stopOnFail) state.stopped = true;
    const failures = (state.pairFailures.get(cell.pairKey) ?? 0) + 1;
    state.pairFailures.set(cell.pairKey, failures);
    if (failures > opts.maxFailures) state.bailedPairs.add(cell.pairKey);
  }
  return needRecreate;
}

async function spawnTracked(
  fn: SpawnFn,
  state: SchedulerState,
  req: SpawnRequest,
): Promise<number> {
  return fn({
    ...req,
    onChild: (child) => {
      state.liveChildren.add(child);
      child.on("exit", () => state.liveChildren.delete(child));
    },
  });
}

function formatCellDone(workerIndex: number, leaf: string, r: CellResult): string {
  const verdict = r.verdict === "pass" ? "PASS" : "FAIL";
  const judgeCost = r.judgeUsages.reduce((sum, u) => sum + judgeCostUsd(u), 0);
  const cost = r.agentCostUsd + judgeCost;
  return `[w${workerIndex}] ${leaf} ${verdict} (${Math.round(r.durationMs / 1000)}s, $${cost.toFixed(4)})`;
}

function defaultSpawn(req: SpawnRequest): Promise<number> {
  return new Promise((resolve) => {
    const env = req.env ? { ...process.env, ...req.env } : process.env;
    const logFd = req.logFile === undefined ? undefined : openSync(req.logFile, "a");
    const child = spawn(req.command, req.argv, {
      env,
      stdio: logFd === undefined ? "inherit" : ["ignore", logFd, logFd],
    });
    // The child holds dups of the fd; safe to close ours right away.
    if (logFd !== undefined) closeSync(logFd);
    req.onChild?.(child);
    child.on("exit", (code, signal) => {
      if (signal) resolve(128 + signalNumber(signal));
      else resolve(code ?? 1);
    });
    child.on("error", (err) => {
      console.error(err.message);
      resolve(1);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 2;
  if (signal === "SIGTERM") return 15;
  return 1;
}

/**
 * Move the live trajectory dir's per-session files into the just-finished cell's
 * artifact dir. Rename is atomic and O(1); the gateway's writer reopens by path
 * per write, so the next write recreates fresh files at the live dir.
 */
function rotateTrajectory(params: {
  liveTrajectoryDir: string;
  artifactsDir: string;
  cellDirName: string;
  fallbackDir: string;
}): void {
  const dest = params.cellDirName
    ? join(params.artifactsDir, params.cellDirName, "trajectory")
    : params.fallbackDir;
  moveTrajectoryFiles(params.liveTrajectoryDir, dest);
}

/**
 * Archive any per-session files left behind in a worker's live trajectory dir by
 * a prior session, so this matrix's first cell on that worker starts clean.
 */
function archiveLeftoverTrajectory(liveTrajectoryDir: string, artifactsDir: string): void {
  moveTrajectoryFiles(liveTrajectoryDir, join(artifactsDir, "trajectory.leftover"));
}

function moveTrajectoryFiles(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  let files: string[];
  try {
    files = readdirSync(srcDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  if (files.length === 0) return;
  mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    const dest = join(destDir, file);
    try {
      renameSync(join(srcDir, file), dest);
    } catch (err) {
      console.warn(`run: failed to move trajectory file to ${dest}:`, (err as Error).message);
    }
  }
}

function synthesizeFailedResult(params: {
  scenario: string;
  channel: string;
  model: string;
  iter: number;
  resultsPath: string;
  childExit: number;
}): CellResult {
  console.warn(
    `run: missing or invalid cell record at ${params.resultsPath} (runner exit ${params.childExit}) — counting as fail`,
  );
  return {
    schemaVersion: 3,
    scenarioId: params.scenario,
    channel: params.channel,
    model: params.model,
    iterationIndex: params.iter,
    verdict: "fail",
    durationMs: 0,
    conversationId: "",
    artifactDirName: "",
    agentCostUsd: 0,
    agentTurns: 0,
    judgeUsd: 0,
    judgeUsages: [],
  };
}
