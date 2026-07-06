import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CellResult, cellLeafName } from "../src/cell-result.js";
import {
  expandChannelSelection,
  type MatrixOptions,
  runMatrix,
  type SpawnRequest,
  type WorkerContext,
} from "../src/loop.js";

function makeConfig(channels: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-test-loop-"));
  const path = join(dir, "openclaw.json");
  const cfg: Record<string, Record<string, unknown>> = { channels: {} };
  for (const c of channels) cfg.channels[c] = {};
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

describe("expandChannelSelection", () => {
  const cfg = makeConfig(["discord-mock", "slack-mock"]);

  it("returns a single id", () => {
    expect(expandChannelSelection("discord-mock", cfg)).toEqual(["discord-mock"]);
  });

  it("returns a comma-separated list", () => {
    expect(expandChannelSelection("discord-mock,slack-mock", cfg)).toEqual([
      "discord-mock",
      "slack-mock",
    ]);
  });

  it("expands 'all' to the configured channels, alphabetically", () => {
    const reversed = makeConfig(["slack-mock", "discord-mock"]);
    expect(expandChannelSelection("all", reversed)).toEqual(["discord-mock", "slack-mock"]);
  });

  it("dedupes repeated ids, order preserved", () => {
    expect(expandChannelSelection("slack-mock,discord-mock,slack-mock", cfg)).toEqual([
      "slack-mock",
      "discord-mock",
    ]);
  });

  it("throws on unknown id", () => {
    expect(() => expandChannelSelection("nope", cfg)).toThrow(/unknown channel/);
  });
});

const RESULTS_DIR = "/results";

function makeWorkers(count: number): WorkerContext[] {
  const workers: WorkerContext[] = [];
  for (let i = 1; i <= count; ++i) {
    workers.push({
      index: i,
      composeArgs: ["compose", "-p", `proj-w${i}`],
      gatewayLogsDir: `/nonexistent/gateway-logs/w${i}`,
      workspaceDir: `/nonexistent/workers/w${i}/workspace`,
      wasRunningBefore: false,
    });
  }
  return workers;
}

function makeOpts(
  fake: Pick<MatrixOptions, "spawnRunner" | "spawnRecreate" | "readResult">,
  overrides: Partial<MatrixOptions>,
): MatrixOptions {
  const workers = overrides.workers ?? makeWorkers(1);
  return {
    scenarios: ["S"],
    channels: ["C"],
    models: [{ id: "m", ref: "p/m" }],
    renderConfigPath: (m) => `/cfg/${m.id}.json`,
    iterations: 1,
    maxFailures: 1,
    stopOnFail: false,
    reuseStack: false,
    parallel: workers.length,
    workers,
    refreshWorkspace: () => {},
    artifactsDir: "/nonexistent/artifacts",
    resultsDir: RESULTS_DIR,
    runnerResultsDir: "/runner-results",
    baseStamp: "stamp",
    ...fake,
    ...overrides,
  };
}

function argvFlag(argv: string[], flag: string): string {
  return argv[argv.indexOf(flag) + 1];
}

function fakeCellResult(
  argv: string[],
  verdict: "pass" | "fail",
): { path: string; result: CellResult } {
  const scenario = argvFlag(argv, "--scenario");
  const channel = argvFlag(argv, "--channel");
  const model = argvFlag(argv, "--model-id");
  const iter = Number(argvFlag(argv, "--iteration-index"));
  const width = Number(argvFlag(argv, "--iteration-width"));
  const leaf = cellLeafName({
    scenarioId: scenario,
    modelId: model,
    channel,
    iterationIndex: iter,
    iterationWidth: width,
  });
  return {
    path: join(RESULTS_DIR, `${leaf}.json`),
    result: {
      schemaVersion: 3,
      scenarioId: scenario,
      channel,
      model,
      iterationIndex: iter,
      verdict,
      durationMs: 1,
      conversationId: "x",
      artifactDirName: "",
      agentCostUsd: 0,
      agentTurns: 0,
      judgeUsd: 0,
      judgeUsages: [],
    },
  };
}

interface CallLog {
  kind: "recreate" | "runner";
  argv: string[];
  env: Record<string, string> | undefined;
  logFile: string | undefined;
}

interface FakeSetup {
  calls: CallLog[];
  spawnRecreate: (req: SpawnRequest) => Promise<number>;
  spawnRunner: (req: SpawnRequest) => Promise<number>;
  readResult: (path: string) => CellResult | undefined;
}

/** Immediate-completion fake. Outcomes keyed `${scenario}|${channel}|${iter}`, default pass. */
function setupFake(outcomes: Record<string, "pass" | "fail">): FakeSetup {
  const calls: CallLog[] = [];
  const resultsByPath = new Map<string, CellResult>();
  const spawnRecreate = async (req: SpawnRequest) => {
    calls.push({ kind: "recreate", argv: req.argv, env: req.env, logFile: req.logFile });
    return 0;
  };
  const spawnRunner = async (req: SpawnRequest) => {
    calls.push({ kind: "runner", argv: req.argv, env: req.env, logFile: req.logFile });
    const scenario = argvFlag(req.argv, "--scenario");
    const channel = argvFlag(req.argv, "--channel");
    const iter = argvFlag(req.argv, "--iteration-index");
    const verdict = outcomes[`${scenario}|${channel}|${iter}`] ?? "pass";
    const { path, result } = fakeCellResult(req.argv, verdict);
    resultsByPath.set(path, result);
    return verdict === "pass" ? 0 : 1;
  };
  const readResult = (path: string) => resultsByPath.get(path);
  return { calls, spawnRecreate, spawnRunner, readResult };
}

function runnerOrder(calls: CallLog[], format: (argv: string[]) => string): string[] {
  return calls.filter((c) => c.kind === "runner").map((c) => format(c.argv));
}

function recreateCount(calls: CallLog[]): number {
  return calls.filter((c) => c.kind === "recreate").length;
}

describe("runMatrix, pool of 1", () => {
  it("runs cells in expansion order: scenarios → channels → iterations", async () => {
    const fake = setupFake({});
    const exit = await runMatrix(
      makeOpts(fake, {
        scenarios: ["S1", "S2"],
        channels: ["C1", "C2"],
        iterations: 2,
        reuseStack: true,
      }),
    );
    expect(exit).toBe(0);
    const order = runnerOrder(
      fake.calls,
      (argv) =>
        `${argvFlag(argv, "--scenario")}|${argvFlag(argv, "--channel")}|${argvFlag(argv, "--model-id")}|${argvFlag(argv, "--iteration-index")}`,
    );
    expect(order).toEqual([
      "S1|C1|m|1",
      "S1|C1|m|2",
      "S1|C2|m|1",
      "S1|C2|m|2",
      "S2|C1|m|1",
      "S2|C1|m|2",
      "S2|C2|m|1",
      "S2|C2|m|2",
    ]);
  });

  it("iterates models as the outermost dimension and recreates per model boundary", async () => {
    const fake = setupFake({});
    await runMatrix(
      makeOpts(fake, {
        scenarios: ["S1", "S2"],
        models: [
          { id: "m1", ref: "p/m1" },
          { id: "m2", ref: "p/m2" },
        ],
        reuseStack: true,
      }),
    );
    const order = runnerOrder(
      fake.calls,
      (argv) => `${argvFlag(argv, "--model-id")}|${argvFlag(argv, "--scenario")}`,
    );
    // model → scenario → channel: each model's whole sweep runs before the next.
    expect(order).toEqual(["m1|S1", "m1|S2", "m2|S1", "m2|S2"]);
    // Lazy creation is the first recreate; the m2 boundary forces the second.
    expect(recreateCount(fake.calls)).toBe(2);
  });

  it("bails the pair when failures exceed maxFailures, continues others", async () => {
    const fake = setupFake({
      "A|C|1": "fail",
      "A|C|2": "fail",
      "A|C|3": "fail",
    });
    const exit = await runMatrix(
      makeOpts(fake, { scenarios: ["A", "B"], iterations: 3, reuseStack: true }),
    );
    expect(exit).toBe(1);
    const order = runnerOrder(
      fake.calls,
      (argv) => `${argvFlag(argv, "--scenario")}|${argvFlag(argv, "--iteration-index")}`,
    );
    // Pair A: iters 1 + 2 (second fail crosses maxFailures=1 → bail). Pair B: all 3.
    expect(order).toEqual(["A|1", "A|2", "B|1", "B|2", "B|3"]);
  });

  it("recreates once per cell without reuseStack", async () => {
    const fake = setupFake({});
    await runMatrix(makeOpts(fake, { iterations: 3 }));
    expect(recreateCount(fake.calls)).toBe(3);
  });

  it("with reuseStack, a single model recreates exactly once — the lazy creation", async () => {
    const fake = setupFake({});
    await runMatrix(makeOpts(fake, { iterations: 2, reuseStack: true }));
    expect(recreateCount(fake.calls)).toBe(1);
  });

  it("keeps inherited stdio (no logFile) and passes the worker env on every spawn", async () => {
    const fake = setupFake({});
    const workers = makeWorkers(1);
    await runMatrix(makeOpts(fake, { workers }));
    expect(fake.calls.length).toBe(2);
    for (const call of fake.calls) {
      expect(call.logFile).toBeUndefined();
      expect(call.env).toEqual({
        OPENCLAW_CONFIG_PATH: "/cfg/m.json",
        OPENCLAW_TEST_GATEWAY_LOGS_DIR: workers[0].gatewayLogsDir,
        OPENCLAW_WORKSPACE_DIR: workers[0].workspaceDir,
      });
      expect(call.argv.slice(0, 3)).toEqual(["compose", "-p", "proj-w1"]);
    }
  });

  it("returns the recreate exit code when a recreate fails", async () => {
    const fake = setupFake({});
    const failingRecreate = async (req: SpawnRequest) => {
      fake.calls.push({ kind: "recreate", argv: req.argv, env: req.env, logFile: req.logFile });
      return 17;
    };
    const exit = await runMatrix(
      makeOpts(fake, { scenarios: ["S1", "S2"], spawnRecreate: failingRecreate }),
    );
    expect(exit).toBe(17);
    expect(runnerOrder(fake.calls, () => "x")).toEqual([]);
  });
});

interface StartedRun {
  argv: string[];
  env: Record<string, string> | undefined;
  logFile: string | undefined;
  project: string;
  finish: (verdict: "pass" | "fail") => void;
}

interface ManualFake {
  started: StartedRun[];
  recreates: CallLog[];
  spawnRecreate: (req: SpawnRequest) => Promise<number>;
  spawnRunner: (req: SpawnRequest) => Promise<number>;
  readResult: (path: string) => CellResult | undefined;
}

/** Runner spawns stay pending until the test calls `finish(verdict)`. */
function setupManualFake(): ManualFake {
  const started: StartedRun[] = [];
  const recreates: CallLog[] = [];
  const resultsByPath = new Map<string, CellResult>();
  const spawnRecreate = async (req: SpawnRequest) => {
    recreates.push({ kind: "recreate", argv: req.argv, env: req.env, logFile: req.logFile });
    return 0;
  };
  const spawnRunner = (req: SpawnRequest) =>
    new Promise<number>((resolveSpawn) => {
      started.push({
        argv: req.argv,
        env: req.env,
        logFile: req.logFile,
        project: req.argv[req.argv.indexOf("-p") + 1],
        finish: (verdict) => {
          const { path, result } = fakeCellResult(req.argv, verdict);
          resultsByPath.set(path, result);
          resolveSpawn(verdict === "pass" ? 0 : 1);
        },
      });
    });
  const readResult = (path: string) => resultsByPath.get(path);
  return { started, recreates, spawnRecreate, spawnRunner, readResult };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50; ++i) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor: condition not reached");
}

function inFlightProjects(started: StartedRun[], finished: Set<StartedRun>): string[] {
  return started.filter((s) => !finished.has(s)).map((s) => s.project);
}

describe("runMatrix, pool of K", () => {
  it("runs cells concurrently, never two on one worker, with per-worker spawn env and log files", async () => {
    const fake = setupManualFake();
    const workers = makeWorkers(2);
    const byProject = new Map(workers.map((w) => [`proj-w${w.index}`, w]));
    const finished = new Set<StartedRun>();
    const done = runMatrix(makeOpts(fake, { scenarios: ["S1", "S2", "S3", "S4"], workers }));

    await waitFor(() => fake.started.length === 2);
    expect(new Set(inFlightProjects(fake.started, finished)).size).toBe(2);
    for (const run of fake.started) {
      const worker = byProject.get(run.project) as WorkerContext;
      expect(run.env).toEqual({
        OPENCLAW_CONFIG_PATH: "/cfg/m.json",
        OPENCLAW_TEST_GATEWAY_LOGS_DIR: worker.gatewayLogsDir,
        OPENCLAW_WORKSPACE_DIR: worker.workspaceDir,
      });
      expect(run.logFile).toBe(join(RESULTS_DIR, `m-${argvFlag(run.argv, "--scenario")}-C.log`));
    }

    fake.started[0].finish("pass");
    finished.add(fake.started[0]);
    await waitFor(() => fake.started.length === 3);
    // The freed worker picks up the next cell; the other is still busy.
    expect(fake.started[2].project).toBe(fake.started[0].project);
    const flying = inFlightProjects(fake.started, finished);
    expect(new Set(flying).size).toBe(flying.length);

    for (const run of fake.started) {
      if (!finished.has(run)) {
        run.finish("pass");
        finished.add(run);
      }
    }
    await waitFor(() => fake.started.length === 4);
    for (const run of fake.started) {
      if (!finished.has(run)) run.finish("pass");
    }
    expect(await done).toBe(0);
  });

  it("spreads concurrently-running cells across models", async () => {
    const fake = setupManualFake();
    const done = runMatrix(
      makeOpts(fake, {
        scenarios: ["S1", "S2"],
        models: [
          { id: "m1", ref: "p/m1" },
          { id: "m2", ref: "p/m2" },
        ],
        workers: makeWorkers(2),
      }),
    );
    await waitFor(() => fake.started.length === 2);
    const models = fake.started.map((s) => argvFlag(s.argv, "--model-id"));
    expect(new Set(models).size).toBe(2);
    const finished = new Set<StartedRun>();
    const finishAll = () => {
      for (const run of [...fake.started]) {
        if (!finished.has(run)) {
          finished.add(run);
          run.finish("pass");
        }
      }
    };
    finishAll();
    await waitFor(() => fake.started.length === 4);
    finishAll();
    expect(await done).toBe(0);
  });

  it("under reuseStack a worker keeps its loaded model while matching cells remain", async () => {
    const fake = setupManualFake();
    const done = runMatrix(
      makeOpts(fake, {
        scenarios: ["S1", "S2"],
        models: [
          { id: "m1", ref: "p/m1" },
          { id: "m2", ref: "p/m2" },
        ],
        workers: makeWorkers(2),
        reuseStack: true,
      }),
    );
    await waitFor(() => fake.started.length === 2);
    const m2Run = fake.started.find((s) => argvFlag(s.argv, "--model-id") === "m2") as StartedRun;
    m2Run.finish("pass");
    await waitFor(() => fake.started.length === 3);
    // Affinity: the freed worker prefers pending m2|S2 over the lower-index m1|S2.
    expect(argvFlag(fake.started[2].argv, "--model-id")).toBe("m2");
    expect(argvFlag(fake.started[2].argv, "--scenario")).toBe("S2");
    expect(fake.started[2].project).toBe(m2Run.project);
    // Free the m1 worker first so it claims m1|S2 by affinity, keeping its model.
    const m1Run = fake.started.find((s) => argvFlag(s.argv, "--model-id") === "m1") as StartedRun;
    m1Run.finish("pass");
    await waitFor(() => fake.started.length === 4);
    expect(argvFlag(fake.started[3].argv, "--model-id")).toBe("m1");
    expect(fake.started[3].project).toBe(m1Run.project);
    fake.started[2].finish("pass");
    fake.started[3].finish("pass");
    expect(await done).toBe(0);
    // One lazy creation per worker; affinity avoided any model-boundary recreate.
    expect(fake.recreates.length).toBe(2);
  });

  it("bails a pair best-effort: no new dispatch, in-flight overshoot recorded", async () => {
    const fake = setupManualFake();
    const done = runMatrix(
      makeOpts(fake, {
        scenarios: ["A"],
        iterations: 3,
        maxFailures: 0,
        workers: makeWorkers(2),
      }),
    );
    await waitFor(() => fake.started.length === 2);
    fake.started[0].finish("fail");
    fake.started[1].finish("fail");
    expect(await done).toBe(1);
    // Iteration 3 is never dispatched; the in-flight second fail is recorded, not cancelled.
    expect(fake.started.length).toBe(2);
  });

  it("stops dispatching on stop-on-fail and drains in-flight cells", async () => {
    const fake = setupManualFake();
    const done = runMatrix(
      makeOpts(fake, {
        scenarios: ["S1", "S2", "S3"],
        stopOnFail: true,
        workers: makeWorkers(2),
      }),
    );
    await waitFor(() => fake.started.length === 2);
    fake.started[0].finish("fail");
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.started.length).toBe(2);
    fake.started[1].finish("pass");
    expect(await done).toBe(1);
    expect(fake.started.length).toBe(2);
  });
});
