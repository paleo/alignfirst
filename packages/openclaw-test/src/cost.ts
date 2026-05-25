import type { JudgeUsage } from "./judge.js";

// USD per million tokens. Judge never uses prompt caching. Keys are LiteLLM-style
// "provider/model" refs. Add models as needed.
const JUDGE_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

const warnedUnknownModels = new Set<string>();

export function judgeCostUsd(usage: JudgeUsage): number {
  const key = usage.model.replace(/-\d{8}$/, "");
  const price = JUDGE_PRICING[key];
  if (!price) {
    if (!warnedUnknownModels.has(key)) {
      warnedUnknownModels.add(key);
      console.warn(
        `cost: no JUDGE_PRICING entry for ${JSON.stringify(key)}; judge cost will report 0. Add it to src/cost.ts.`,
      );
    }
    return 0;
  }
  return (
    (usage.inputTokens * price.input) / 1_000_000 + (usage.outputTokens * price.output) / 1_000_000
  );
}
