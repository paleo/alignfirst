import type { JudgeUsage } from "./judge.js";

/**
 * USD cost of one judge call, priced from `OPENCLAW_TEST_JUDGE_INPUT_USD_PER_MTOK` and
 * `OPENCLAW_TEST_JUDGE_OUTPUT_USD_PER_MTOK`; `undefined` (unknown) when either is unset.
 */
export function judgeCostUsd(usage: JudgeUsage): number | undefined {
  const inputPrice = readPricePerMtok("OPENCLAW_TEST_JUDGE_INPUT_USD_PER_MTOK");
  const outputPrice = readPricePerMtok("OPENCLAW_TEST_JUDGE_OUTPUT_USD_PER_MTOK");
  if (inputPrice === undefined || outputPrice === undefined) return;
  return (usage.inputTokens * inputPrice + usage.outputTokens * outputPrice) / 1_000_000;
}

/** Sums costs; one unknown cost makes the sum unknown. */
export function sumCosts(costs: (number | undefined)[]): number | undefined {
  let total = 0;
  for (const cost of costs) {
    if (cost === undefined) return;
    total += cost;
  }
  return total;
}

function readPricePerMtok(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return;
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(
      `${name} must be a non-negative number of USD per million tokens; got ${JSON.stringify(raw)}`,
    );
  }
  return price;
}
