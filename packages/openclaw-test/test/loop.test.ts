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
      schemaVersion: 3,
      scenarioId: scenario,
      channel,
      model: "m",
      iterationIndex: iter,
      verdict,
      durationMs: 1,
      conversationId: "x",
      artifactDirName: "x",
      agentCostUsd: 0,
      agentTurns: 0,
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
      gatewayFreshOnFirstModel: true,
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
      gatewayFreshOnFirstModel: true,
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
    // model → scenario → channel: each model's whole sweep runs before the next.
    expect(order).toEqual(["m1|S1", "m1|S2", "m2|S1", "m2|S2"]);
    // reuseStack skips per-cell recreates; only the second model boundary forces one.
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
      gatewayFreshOnFirstModel: true,
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
      gatewayFreshOnFirstModel: true,
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

  it("skips the first recreate when the gateway is fresh on the first model, recreates subsequent cells", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S"],
      channels: ["C"],
      iterations: 3,
      maxFailures: 1,
      reuseStack: false,
      gatewayFreshOnFirstModel: true,
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

  it("recreates for the first model when reusing a stack not on its config", async () => {
    const fake = setupFake({});
    await runMatrix({
      scenarios: ["S"],
      channels: ["C"],
      iterations: 2,
      maxFailures: 1,
      reuseStack: true,
      gatewayFreshOnFirstModel: false,
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
    // The first cell must recreate to load the model; reuseStack skips the rest.
    expect(fake.calls.filter((c) => c.kind === "recreate")).toHaveLength(1);
  });
});
