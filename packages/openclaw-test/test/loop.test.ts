import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CellResult } from "../src/cell-result.js";
import { expandChannelSelection, runMatrix, type SpawnRequest } from "../src/loop.js";

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

  it("expands 'all' to the configured channels", () => {
    expect(expandChannelSelection("all", cfg)).toEqual(["discord-mock", "slack-mock"]);
  });

  it("throws on unknown id", () => {
    expect(() => expandChannelSelection("nope", cfg)).toThrow(/unknown channel/);
  });
});

interface CallLog {
  kind: "recreate" | "runner";
  argv: string[];
}

interface FakeSetup {
  calls: CallLog[];
  cellOutcomes: Map<string, "pass" | "fail">;
  spawnRecreate: (req: SpawnRequest) => Promise<number>;
  spawnRunner: (req: SpawnRequest) => Promise<number>;
  readResult: (path: string) => CellResult | undefined;
}

function setupFake(outcomes: Record<string, "pass" | "fail">): FakeSetup {
  const calls: CallLog[] = [];
  const cellOutcomes = new Map<string, "pass" | "fail">(Object.entries(outcomes));
  let pendingCell: { scenario: string; channel: string; iter: number } | undefined;

  const spawnRecreate = async (req: SpawnRequest) => {
    calls.push({ kind: "recreate", argv: req.argv });
    return 0;
  };
  const spawnRunner = async (req: SpawnRequest) => {
    calls.push({ kind: "runner", argv: req.argv });
    const scenario = req.argv[req.argv.indexOf("--scenario") + 1];
    const channel = req.argv[req.argv.indexOf("--channel") + 1];
    const iter = Number(req.argv[req.argv.indexOf("--iteration-index") + 1]);
    pendingCell = { scenario, channel, iter };
    const verdict = cellOutcomes.get(`${scenario}|${channel}|${iter}`) ?? "pass";
    return verdict === "pass" ? 0 : 1;
  };
  const readResult = (_path: string): CellResult | undefined => {
    if (!pendingCell) return undefined;
    const { scenario, channel, iter } = pendingCell;
    const verdict = cellOutcomes.get(`${scenario}|${channel}|${iter}`) ?? "pass";
    return {
      schemaVersion: 2,
      scenarioId: scenario,
      channel,
      model: "m",
      iterationIndex: iter,
      verdict,
      durationMs: 1,
      conversationId: "x",
      artifactDirName: "x",
      gatewayCostUsd: 0,
      gatewayTurns: 0,
      judgeUsd: 0,
      judgeUsages: [],
    };
  };
  return { calls, cellOutcomes, spawnRecreate, spawnRunner, readResult };
}

describe("runMatrix", () => {
  it("iterates scenarios → channels → iterations", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S1", "S2"],
      channels: ["C1", "C2"],
      iterations: 2,
      maxFailures: 1,
      reuseStack: true,
      skipFirstRestart: false,
      models: [{ id: "m", ref: "p/m" }],
      renderConfigPath: () => "/tmp/openclaw.json",
      composeArgs: ["compose"],
      artifactsDir: "/tmp",
      resultsDir: "/tmp",
      runnerResultsDir: "/tmp",
      gatewayLogsDir: "/tmp",
      stopOnFail: false,
      baseStamp: "stamp",
      spawnRunner: fake.spawnRunner,
      spawnRecreate: fake.spawnRecreate,
      readResult: fake.readResult,
    });
    const runners = fake.calls.filter((c) => c.kind === "runner");
    const order = runners.map((c) => {
      const s = c.argv[c.argv.indexOf("--scenario") + 1];
      const ch = c.argv[c.argv.indexOf("--channel") + 1];
      const m = c.argv[c.argv.indexOf("--model-id") + 1];
      const it = c.argv[c.argv.indexOf("--iteration-index") + 1];
      return `${s}|${ch}|${m}|${it}`;
    });
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

  it("iterates models as the outermost dimension and forces a recreate per model boundary", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S1", "S2"],
      channels: ["C"],
      models: [
        { id: "m1", ref: "p/m1" },
        { id: "m2", ref: "p/m2" },
      ],
      renderConfigPath: () => "/tmp/openclaw.json",
      iterations: 1,
      maxFailures: 1,
      reuseStack: true,
      skipFirstRestart: false,
      composeArgs: ["compose"],
      artifactsDir: "/tmp",
      resultsDir: "/tmp",
      runnerResultsDir: "/tmp",
      gatewayLogsDir: "/tmp",
      stopOnFail: false,
      baseStamp: "stamp",
      spawnRunner: fake.spawnRunner,
      spawnRecreate: fake.spawnRecreate,
      readResult: fake.readResult,
    });
    const runners = fake.calls.filter((c) => c.kind === "runner");
    const order = runners.map((c) => {
      const s = c.argv[c.argv.indexOf("--scenario") + 1];
      const m = c.argv[c.argv.indexOf("--model-id") + 1];
      return `${m}|${s}`;
    });
    expect(order).toEqual(["m1|S1", "m1|S2", "m2|S1", "m2|S2"]);
    // reuseStack skips per-cell recreates, but the second model boundary still forces one.
    expect(fake.calls.filter((c) => c.kind === "recreate")).toHaveLength(1);
  });

  it("bails the pair when failures exceed maxFailures, continues others", async () => {
    const fake = setupFake({
      "A|C|1": "fail",
      "A|C|2": "fail",
      "A|C|3": "fail",
      "B|C|1": "pass",
      "B|C|2": "pass",
      "B|C|3": "pass",
    });
    await runMatrix({
      scenarios: ["A", "B"],
      channels: ["C"],
      iterations: 3,
      maxFailures: 1,
      reuseStack: true,
      skipFirstRestart: false,
      models: [{ id: "m", ref: "p/m" }],
      renderConfigPath: () => "/tmp/openclaw.json",
      composeArgs: ["compose"],
      artifactsDir: "/tmp",
      resultsDir: "/tmp",
      runnerResultsDir: "/tmp",
      gatewayLogsDir: "/tmp",
      stopOnFail: false,
      baseStamp: "stamp",
      spawnRunner: fake.spawnRunner,
      spawnRecreate: fake.spawnRecreate,
      readResult: fake.readResult,
    });
    const runners = fake.calls.filter((c) => c.kind === "runner");
    const order = runners.map((c) => {
      const s = c.argv[c.argv.indexOf("--scenario") + 1];
      const it = c.argv[c.argv.indexOf("--iteration-index") + 1];
      return `${s}|${it}`;
    });
    // Pair A: iters 1 + 2 (second fail crosses maxFailures=1 → bail). Pair B: all 3.
    expect(order).toEqual(["A|1", "A|2", "B|1", "B|2", "B|3"]);
  });

  it("does not recreate when reuseStack is set", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S"],
      channels: ["C"],
      iterations: 2,
      maxFailures: 1,
      reuseStack: true,
      skipFirstRestart: false,
      models: [{ id: "m", ref: "p/m" }],
      renderConfigPath: () => "/tmp/openclaw.json",
      composeArgs: ["compose"],
      artifactsDir: "/tmp",
      resultsDir: "/tmp",
      runnerResultsDir: "/tmp",
      gatewayLogsDir: "/tmp",
      stopOnFail: false,
      baseStamp: "stamp",
      spawnRunner: fake.spawnRunner,
      spawnRecreate: fake.spawnRecreate,
      readResult: fake.readResult,
    });
    expect(fake.calls.filter((c) => c.kind === "recreate")).toHaveLength(0);
  });

  it("skips first recreate when skipFirstRestart is set, recreates subsequent cells", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S"],
      channels: ["C"],
      iterations: 3,
      maxFailures: 1,
      reuseStack: false,
      skipFirstRestart: true,
      models: [{ id: "m", ref: "p/m" }],
      renderConfigPath: () => "/tmp/openclaw.json",
      composeArgs: ["compose"],
      artifactsDir: "/tmp",
      resultsDir: "/tmp",
      runnerResultsDir: "/tmp",
      gatewayLogsDir: "/tmp",
      stopOnFail: false,
      baseStamp: "stamp",
      spawnRunner: fake.spawnRunner,
      spawnRecreate: fake.spawnRecreate,
      readResult: fake.readResult,
    });
    expect(fake.calls.filter((c) => c.kind === "recreate")).toHaveLength(2);
  });
});
