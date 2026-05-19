import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChannelId, createContext } from "./context.js";
import type { JudgeUsage } from "./judge.js";

const ARTIFACTS_ROOT = process.env.QA_ARTIFACTS_ROOT ?? "/opt/qa-artifacts";
const SCENARIOS_ROOT = process.env.QA_SCENARIOS_ROOT ?? "/opt/qa-src/scenarios";
const GATEWAY_LOG_PATH =
  process.env.QA_GATEWAY_ANTHROPIC_LOG ?? "/home/kclaw/.openclaw/logs/anthropic-payload.jsonl";

// USD per million tokens. Judge never uses prompt caching. Add models as needed.
const JUDGE_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

const CHANNELS: ChannelId[] = ["discord-mock", "slack-mock"];

type ChannelArg = ChannelId | "all";

function parseArgs(argv: string[]): {
  channel: ChannelArg;
  scenarios: string[];
  all: boolean;
  concurrency: number;
} {
  let channel: ChannelArg | null = null;
  let all = false;
  let concurrency = Number(process.env.QA_CONCURRENCY ?? "4");
  const scenarios: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--channel") {
      channel = argv[++i] as ChannelArg;
    } else if (a.startsWith("--channel=")) {
      channel = a.slice("--channel=".length) as ChannelArg;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--concurrency") {
      concurrency = Number(argv[++i]);
    } else if (a.startsWith("--concurrency=")) {
      concurrency = Number(a.slice("--concurrency=".length));
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      scenarios.push(a);
    }
  }
  if (channel !== "discord-mock" && channel !== "slack-mock" && channel !== "all") {
    throw new Error("runner: --channel discord-mock|slack-mock|all is required");
  }
  if (all && scenarios.length > 0) {
    throw new Error("runner: pass either --all or a scenario list, not both");
  }
  if (!all && scenarios.length === 0) {
    throw new Error("runner: must pass --all or one or more scenario names");
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    concurrency = 4;
  }
  return { channel, scenarios, all, concurrency };
}

function discoverScenarios(): string[] {
  return readdirSync(SCENARIOS_ROOT)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -".ts".length))
    .sort();
}

function shortRand(): string {
  return randomBytes(3).toString("hex");
}

async function runPool<T>(tasks: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const t = tasks[i] as () => Promise<T>;
      results[i] = await t();
    }
  }
  const workers = Array.from({ length: Math.min(n, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

type TaskResult = {
  scenarioId: string;
  channel: ChannelId;
  conversationId: string;
  status: "pass" | "fail";
  durationMs: number;
  outDir: string;
  judgeUsages: JudgeUsage[];
};

function judgeCostUsd(usage: JudgeUsage): number {
  const stripped = usage.model.replace(/^anthropic\//, "").replace(/-\d{8}$/, "");
  const price = JUDGE_PRICING[stripped];
  if (!price) {
    return 0;
  }
  return (
    (usage.inputTokens * price.input) / 1_000_000 + (usage.outputTokens * price.output) / 1_000_000
  );
}

function readGatewayCostSince(startTsIso: string): { cost: number; turns: number } {
  let raw: string;
  try {
    raw = readFileSync(GATEWAY_LOG_PATH, "utf8");
  } catch {
    return { cost: 0, turns: 0 };
  }
  let cost = 0;
  let turns = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: { ts?: string; stage?: string; usage?: { cost?: { total?: number } } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.stage !== "usage" || !entry.ts || entry.ts < startTsIso) continue;
    const total = entry.usage?.cost?.total;
    if (typeof total === "number") {
      cost += total;
      turns += 1;
    }
  }
  return { cost, turns };
}

async function runOne(params: {
  baseStamp: string;
  scenarioId: string;
  channel: ChannelId;
}): Promise<TaskResult> {
  const { baseStamp, scenarioId, channel } = params;
  const conversationId = `${scenarioId}-${channel}-${shortRand()}`;
  const outDir = join(ARTIFACTS_ROOT, `${baseStamp}-${scenarioId}-${channel}`);
  mkdirSync(outDir, { recursive: true });

  const ctx = createContext({ channel, conversationId });
  const start = Date.now();
  let status: "pass" | "fail" = "pass";
  let failureMessage: string | undefined;

  try {
    const mod = await import(`${SCENARIOS_ROOT}/${scenarioId}.ts`);
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error(`scenario ${scenarioId} has no default export function`);
    }
    await fn(ctx);
  } catch (err) {
    status = "fail";
    failureMessage =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    ctx.log(`FAIL — ${failureMessage}`);
  }

  const durationMs = Date.now() - start;
  const { logLines, assertions, judgeCalls, judgeUsages } = ctx._drain();

  const report = [
    `# QA report: ${scenarioId}`,
    "",
    `**status:** ${status} (channel: ${channel}, conversationId: ${conversationId})`,
    `**durationMs:** ${durationMs}`,
    "",
    "## Log",
    ...logLines,
    "",
    ...(failureMessage ? ["## Failure", "```", failureMessage, "```", ""] : []),
  ].join("\n");

  const summary = {
    scenario: scenarioId,
    channel,
    conversationId,
    status,
    durationMs,
    assertions,
    judgeCalls,
    failureMessage,
  };

  writeFileSync(join(outDir, "report.md"), report);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[${channel}] ${scenarioId} ${status} in ${durationMs}ms — ${outDir}`);
  return { scenarioId, channel, conversationId, status, durationMs, outDir, judgeUsages };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const scenarios = opts.all ? discoverScenarios() : opts.scenarios;
  if (scenarios.length === 0) {
    throw new Error("no scenarios discovered");
  }
  const channels: ChannelId[] = opts.channel === "all" ? CHANNELS : [opts.channel];

  console.log(
    `runner: channels=[${channels.join(",")}] scenarios=[${scenarios.join(",")}] concurrency=${opts.concurrency}`,
  );

  const runStartIso = new Date().toISOString();
  const baseStamp = runStartIso.replace(/[:.]/g, "-");
  const tasks: Array<() => Promise<TaskResult>> = [];
  for (const scenarioId of scenarios) {
    for (const channel of channels) {
      tasks.push(() => runOne({ baseStamp, scenarioId, channel }));
    }
  }

  const results = await runPool(tasks, opts.concurrency);

  console.log("");
  console.log("Summary:");
  for (const r of results) {
    const verdict = r.status.toUpperCase().padEnd(4, " ");
    console.log(
      `  ${verdict}  ${r.channel.padEnd(12, " ")}  ${r.scenarioId.padEnd(40, " ")}  ${r.durationMs}ms`,
    );
  }
  console.log("");
  console.log("Artifacts:");
  for (const r of results) console.log(`  ${r.outDir}`);

  const judgeCost = results
    .flatMap((r) => r.judgeUsages)
    .reduce((sum, u) => sum + judgeCostUsd(u), 0);
  // openclaw flushes its `stage:"usage"` log line a couple of seconds after the
  // outbound message hits the bus — wait so it lands before we read.
  await new Promise((r) => setTimeout(r, 5_000));
  const { cost: gatewayCost, turns: gatewayTurns } = readGatewayCostSince(runStartIso);
  const totalCost = gatewayCost + judgeCost;
  console.log("");
  console.log(
    `Total LLM cost: $${totalCost.toFixed(4)} (gateway: $${gatewayCost.toFixed(4)} over ${gatewayTurns} turns, judge: $${judgeCost.toFixed(4)})`,
  );

  const anyFail = results.some((r) => r.status === "fail");
  process.exit(anyFail ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("runner crash:", err);
    process.exit(1);
  });
}
