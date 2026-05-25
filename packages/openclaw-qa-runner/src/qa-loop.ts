import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CellResult, readCellResult } from "./cell-result.js";
import { printSummary, printTotalCost } from "./qa-summary.js";

export interface ChannelSelection {
  raw: string;
}

export function expandChannelSelection(raw: string, openclawConfigPath: string): string[] {
  if (!raw) throw new Error("qa: --channel expects a non-empty value");
  const cfg = JSON.parse(readFileSync(openclawConfigPath, "utf8")) as {
    channels?: Record<string, unknown>;
  };
  const allowed = Object.keys(cfg.channels ?? {});
  if (allowed.length === 0) throw new Error(`no channels declared in ${openclawConfigPath}`);
  if (raw === "all") return allowed;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(`qa: --channel expects a non-empty list, got ${JSON.stringify(raw)}`);
  }
  const unknown = ids.filter((c) => !allowed.includes(c));
  if (unknown.length > 0) {
    throw new Error(`unknown channel(s): ${unknown.join(", ")} — allowed: ${allowed.join(", ")}`);
  }
  return ids;
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
  iterations: number;
  maxFailures: number;
  /** Stop the whole matrix at the first failing cell (across all pairs). */
  stopOnFail: boolean;
  reuseStack: boolean;
  skipFirstRestart: boolean;
  composeArgs: string[];
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

  try {
    outer: for (const scenario of opts.scenarios) {
      for (const channel of opts.channels) {
        let pairFailures = 0;
        for (let iter = 1; iter <= opts.iterations; ++iter) {
          if (aborted) break outer;

          const doRestart = !opts.reuseStack && !(opts.skipFirstRestart && isFirstCell);
          if (doRestart) {
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

          if (aborted) break outer;

          const iterSuffix =
            iterationWidth > 0 ? `-${String(iter).padStart(iterationWidth, "0")}` : "";
          const leaf = `${scenario}-${channel}${iterSuffix}`;
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
              iter,
              resultsPath,
              childExit,
            });
          results.push(r);

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

function synthesizeFailedResult(params: {
  scenario: string;
  channel: string;
  iter: number;
  resultsPath: string;
  childExit: number;
}): CellResult {
  console.warn(
    `qa: missing or invalid cell record at ${params.resultsPath} (runner exit ${params.childExit}) — counting as fail`,
  );
  return {
    schemaVersion: 1,
    scenarioId: params.scenario,
    channel: params.channel,
    iterationIndex: params.iter,
    verdict: "fail",
    durationMs: 0,
    conversationId: "",
    artifactDirName: "",
    gatewayCostUsd: 0,
    gatewayTurns: 0,
    judgeUsd: 0,
    judgeUsages: [],
  };
}
