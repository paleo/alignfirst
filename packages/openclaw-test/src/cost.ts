import type { JudgeUsage } from "./judge.js";

// USD per million tokens. Judge never uses prompt caching. Keys are LiteLLM-style
// "provider/model" refs. Add models as needed.
const HAIKU_5_5_PRICING = {
  input: 0.1,
  output: 0.5,
  longContext: { threshold: 100_000, input: 0.5, output: 2.5 },
};
const JUDGE_PRICING: Record<
  string,
  {
    input: number;
    output: number;
    longContext?: { threshold: number; input: number; output: number };
  }
> = {
  "anthropic/claude-haiku-5-5": HAIKU_5_5_PRICING,
  "openrouter/anthropic/claude-haiku-5.5": HAIKU_5_5_PRICING,
  "anthropic/claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "openrouter/anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
};

const warnedUnknownModels = new Set<string>();

export function judgeCostUsd(usage: JudgeUsage): number {
  const key = usage.model.replace(/-\d{8}$/, "");
  const pricing = JUDGE_PRICING[key];
  if (!pricing) {
    if (!warnedUnknownModels.has(key)) {
      warnedUnknownModels.add(key);
      console.warn(
        `cost: no JUDGE_PRICING entry for ${JSON.stringify(key)}; judge cost will report 0. Add it to src/cost.ts.`,
      );
    }
    return 0;
  }
  const price =
    pricing.longContext && usage.inputTokens > pricing.longContext.threshold
      ? pricing.longContext
      : pricing;
  return (
    (usage.inputTokens * price.input) / 1_000_000 + (usage.outputTokens * price.output) / 1_000_000
  );
}
