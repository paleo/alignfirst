import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type CellResult, cellLeafName, readCellResult } from "./cell-result.js";
import type { SelectedModel } from "./models.js";
import { printSummary, printTotalCost } from "./summary.js";

export interface ChannelSelection {
  raw: string;
}

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
   * Renders the chosen model's ref into a run-scoped config and returns its path.
   * The loop repoints `OPENCLAW_CONFIG_PATH` to it before the model-boundary recreate.
   */
  renderConfigPath: (model: SelectedModel) => string;
  iterations: number;
  maxFailures: number;
  /** Stop the whole matrix at the first failing cell (across all pairs). */
  stopOnFail: boolean;
  reuseStack: boolean;
  /**
   * The gateway is already running the first model's rendered config (it was just
   * booted on it), so the first cell needs no recreate to load that model. False
   * when we reused a stack we didn't boot — then the first model must force a
   * recreate, or `--model` would be silently ignored for it.
   */
  gatewayFreshOnFirstModel: boolean;
  composeArgs: string[];
  artifactsDir: string;
  /** Host-side path to the gateway logs dir (bind-mounted into the gateway). */
  gatewayLogsDir: string;
  /** Host-side path to the results dir; the host reads `*.json` from here. */
  resultsDir: string;
  /** Container-side path passed to the runner via `--results-dir`. */
  runnerResultsDir: string;
  baseStamp: string;
  spawnRunner?: SpawnFn;
  spawnRecreate?: SpawnFn;
  readResult?: (path: string) => CellResult | undefined;
}

export type SpawnFn = (args: SpawnRequest) => Promise<number>;

export interface SpawnRequest {
  command: string;
  argv: string[];
  onChild?: (child: ChildProcess) => void;
}

export async function recreateStack(composeArgs: string[]): Promise<number> {
  return defaultSpawn({
    command: "docker",
    argv: [...composeArgs, "up", "-d", "--force-recreate", "--wait", "bus", "gateway"],
  });
}

function defaultSpawn(req: SpawnRequest): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(req.command, req.argv, { stdio: "inherit" });
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

export async function runMatrix(opts: MatrixOptions): Promise<number> {
  const readResult = opts.readResult ?? readCellResult;
  const spawnRunner = opts.spawnRunner ?? defaultSpawn;
  const spawnRecreate = opts.spawnRecreate ?? defaultSpawn;

  let aborted = false;
  let currentChild: ChildProcess | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    aborted = true;
    currentChild?.kill(sig);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const results: CellResult[] = [];
  const iterationWidth = opts.iterations > 1 ? String(opts.iterations).length : 0;
  let isFirstCell = true;
  let exitCode = 0;

  const liveTrajectoryDir = join(opts.gatewayLogsDir, "trajectory");
  archiveLeftoverTrajectory(liveTrajectoryDir, opts.artifactsDir);

  try {
    // Model is the outermost dimension so each model's config is loaded once and
    // its whole sweep runs before the next — minimal gateway recreates under
    // --reuse-stack (one per model boundary). The artifact dir name groups by
    // model→scenario→channel independently (see the cell `leaf` below).
    outer: for (const model of opts.models) {
      // Repoint the gateway config at this model's rendered file, then force a
      // recreate at the model boundary so the gateway reloads the new config —
      // even when reuseStack would otherwise skip it. The first model recreates
      // only if the gateway isn't already running its config.
      process.env.OPENCLAW_CONFIG_PATH = opts.renderConfigPath(model);
      let forceModelRestart = isFirstCell ? !opts.gatewayFreshOnFirstModel : true;
      for (const scenario of opts.scenarios) {
        for (const channel of opts.channels) {
          let pairFailures = 0;
          for (let iter = 1; iter <= opts.iterations; ++iter) {
            if (aborted) break outer;

            const perCellRestart =
              !opts.reuseStack && !(opts.gatewayFreshOnFirstModel && isFirstCell);
            if (perCellRestart || forceModelRestart) {
              const code = await spawnRecreate({
                command: "docker",
                argv: [
                  ...opts.composeArgs,
                  "up",
                  "-d",
                  "--force-recreate",
                  "--wait",
                  "bus",
                  "gateway",
                ],
                onChild: (c) => {
                  currentChild = c;
                },
              });
              currentChild = undefined;
              if (aborted) break outer;
              if (code !== 0) {
                exitCode = code;
                break outer;
              }
            }
            isFirstCell = false;
            forceModelRestart = false;

            if (aborted) break outer;

            const leaf = cellLeafName({
              scenarioId: scenario,
              modelId: model.id,
              channel,
              iterationIndex: iter,
              iterationWidth,
            });
            const resultsPath = join(opts.resultsDir, `${leaf}.json`);

            const runnerArgs = [
              ...opts.composeArgs,
              "run",
              "--rm",
              "--use-aliases",
              "runner",
              "--scenario",
              scenario,
              "--channel",
              channel,
              "--model-id",
              model.id,
              "--model-ref",
              model.ref,
              "--iteration-index",
              String(iter),
              "--iteration-width",
              String(iterationWidth),
              "--base-stamp",
              opts.baseStamp,
              "--results-dir",
              opts.runnerResultsDir,
            ];
            const childExit = await spawnRunner({
              command: "docker",
              argv: runnerArgs,
              onChild: (c) => {
                currentChild = c;
              },
            });
            currentChild = undefined;

            const r =
              readResult(resultsPath) ??
              synthesizeFailedResult({
                scenario,
                channel,
                model: model.id,
                iter,
                resultsPath,
                childExit,
              });
            results.push(r);

            rotateTrajectory({
              liveTrajectoryDir,
              artifactsDir: opts.artifactsDir,
              cellDirName: r.artifactDirName,
              fallbackDir: join(opts.resultsDir, `${leaf}.trajectory`),
            });

            if (r.verdict === "fail") {
              if (opts.stopOnFail) {
                break outer;
              }
              pairFailures += 1;
              if (pairFailures > opts.maxFailures) {
                break;
              }
            }
          }
        }
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  printSummary(results, opts.baseStamp);
  printTotalCost(results);

  if (exitCode !== 0) return exitCode;
  const anyFail = results.some((r) => r.verdict === "fail");
  return anyFail ? 1 : 0;
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
 * Archive any per-session files left behind in the live trajectory dir by a
 * prior session, so this matrix's first cell starts clean.
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
