import { join } from "node:path";
import type { CellResult } from "./cell-result.js";
import { judgeCostUsd } from "./cost.js";

function artifactsRoot(): string {
  return process.env.OPENCLAW_TEST_ARTIFACTS_DIR ?? "/opt/openclaw-test/artifacts";
}

interface PairAggregate {
  scenarioId: string;
  channel: string;
  model: string;
  runCount: number;
  passCount: number;
  durationSumMs: number;
}

function groupByPair(results: CellResult[]): PairAggregate[] {
  const order: string[] = [];
  const map = new Map<string, PairAggregate>();
  for (const r of results) {
    const key = `${r.scenarioId}|${r.channel}|${r.model}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        scenarioId: r.scenarioId,
        channel: r.channel,
        model: r.model,
        runCount: 0,
        passCount: 0,
        durationSumMs: 0,
      };
      map.set(key, agg);
      order.push(key);
    }
    agg.runCount += 1;
    agg.durationSumMs += r.durationMs;
    if (r.verdict === "pass") agg.passCount += 1;
  }
  return order.map((k) => map.get(k) as PairAggregate);
}

export function printSummary(results: CellResult[], baseStamp: string): void {
  const aggregates = groupByPair(results);
  console.log("");
  console.log("Summary:");
  for (const a of aggregates) {
    const passed = a.passCount === a.runCount;
    const verdict = (passed ? "PASS" : "FAIL").padEnd(4, " ");
    const counts = `${a.passCount}/${a.runCount}`.padStart(7, " ");
    console.log(
      `  ${verdict}  ${a.channel.padEnd(12, " ")}  ${a.model.padEnd(20, " ")}  ${a.scenarioId.padEnd(40, " ")}  ${counts}  in ${a.durationSumMs}ms`,
    );
  }
  console.log("");
  console.log("Artifacts:");
  console.log(`  ${join(artifactsRoot(), baseStamp)}`);
}

export function printTotalCost(results: CellResult[]): void {
  console.log("");
  console.log(costLine(results));
  const models = [...new Set(results.map((r) => r.model))];
  if (models.length > 1) {
    console.log("Per-model cost:");
    for (const model of models) {
      console.log(
        `  ${model.padEnd(20, " ")}  ${costLine(results.filter((r) => r.model === model))}`,
      );
    }
  }
}

function costLine(results: CellResult[]): string {
  const judgeCost = results
    .flatMap((r) => r.judgeUsages)
    .reduce((sum, u) => sum + judgeCostUsd(u), 0);
  const gatewayCost = results.reduce((sum, r) => sum + r.gatewayCostUsd, 0);
  const gatewayTurns = results.reduce((sum, r) => sum + r.gatewayTurns, 0);
  const totalCost = gatewayCost + judgeCost;
  return `Total LLM cost: $${totalCost.toFixed(4)} (gateway: $${gatewayCost.toFixed(4)} over ${gatewayTurns} turns, judge: $${judgeCost.toFixed(4)})`;
}
