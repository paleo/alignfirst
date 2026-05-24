import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollQaBus } from "@paleo/openclaw-channel-mock-core";
import {
  type ChannelId,
  createContext,
  type ScenarioContext,
  type ScenarioInternals,
} from "./context.js";
import { judgeCostUsd } from "./cost.js";
import {
  GATEWAY_LOG_PATH,
  gatewayLogExists,
  parseAgentToolCalls,
  readGatewayCostFor,
  waitForGatewayUsage,
} from "./gateway-log.js";
import type { JudgeUsage } from "./judge.js";
import { startMockCliServer } from "./mock-cli-server.js";
import type {
  AgentToolCall,
  AgentToolCallEntry,
  ReportEntry,
  ScenarioFailure,
  ScenarioReport,
} from "./report.js";
import { parseArgs } from "./runner-args.js";

const ARTIFACTS_ROOT = process.env.QA_ARTIFACTS_ROOT ?? "/opt/qa-artifacts";
const SCENARIOS_ROOT = process.env.QA_SCENARIOS_ROOT ?? "/opt/qa-src/scenarios";
const BUS_URL = process.env.QA_BUS_URL ?? "http://bus:43123";
const CHANNELS: ChannelId[] = ["discord-mock", "slack-mock"];

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const scenarios = opts.all ? discoverScenarios() : opts.scenarios;
  if (scenarios.length === 0) throw new Error("no scenarios discovered");
  const channels: ChannelId[] = opts.channel === "all" ? CHANNELS : [opts.channel];
  const { iterations, maxFailures } = opts;

  console.log(
    `runner: channels=[${channels.join(",")}] scenarios=[${scenarios.join(",")}] iterations=${iterations} maxFailures=${maxFailures}`,
  );

  const mockCliServer = startMockCliServer();
  const baseStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const iterationWidth = String(iterations).length;
  const results: TaskResult[] = [];
  const aggregates: PairAggregate[] = [];

  try {
    for (const scenarioId of scenarios) {
      for (const channel of channels) {
        const agg = await runPair({
          scenarioId,
          channel,
          baseStamp,
          iterations,
          iterationWidth,
          maxFailures,
          mockCliServer,
          results,
        });
        aggregates.push(agg);
      }
    }
  } finally {
    await mockCliServer.close();
  }

  printSummary(aggregates, baseStamp);
  printTotalCost(results);
  process.exit(anyPairFailed(aggregates) ? 1 : 0);
}

interface RunPairParams {
  scenarioId: string;
  channel: ChannelId;
  baseStamp: string;
  iterations: number;
  iterationWidth: number;
  maxFailures: number;
  mockCliServer: ReturnType<typeof startMockCliServer>;
  results: TaskResult[];
}

interface PairAggregate {
  scenarioId: string;
  channel: ChannelId;
  runCount: number;
  passCount: number;
  durationSumMs: number;
  stoppedAfter: number | undefined;
}

async function runPair(params: RunPairParams): Promise<PairAggregate> {
  const { scenarioId, channel, iterations, maxFailures, results } = params;
  const agg: PairAggregate = {
    scenarioId,
    channel,
    runCount: 0,
    passCount: 0,
    durationSumMs: 0,
    stoppedAfter: undefined,
  };
  let failures = 0;
  for (let iter = 1; iter <= iterations; ++iter) {
    const r = await runOne({
      baseStamp: params.baseStamp,
      scenarioId,
      channel,
      iteration: iter,
      iterationWidth: params.iterationWidth,
      iterations,
      mockCliServer: params.mockCliServer,
    });
    results.push(r);
    agg.runCount += 1;
    agg.durationSumMs += r.durationMs;
    if (r.verdict === "pass") {
      agg.passCount += 1;
    } else {
      failures += 1;
      if (failures > maxFailures) {
        agg.stoppedAfter = failures;
        break;
      }
    }
  }
  return agg;
}

interface RunOneParams {
  baseStamp: string;
  scenarioId: string;
  channel: ChannelId;
  iteration: number;
  iterationWidth: number;
  iterations: number;
  mockCliServer: ReturnType<typeof startMockCliServer>;
}

interface TaskResult {
  scenarioId: string;
  channel: ChannelId;
  conversationId: string;
  verdict: "pass" | "fail";
  durationMs: number;
  outDir: string;
  judgeUsages: JudgeUsage[];
  gatewayCostUsd: number;
  gatewayTurns: number;
}

async function runOne(params: RunOneParams): Promise<TaskResult> {
  const setup = setupRun(params);
  const {
    ctx,
    internals,
    outDir,
    conversationId,
    accountId,
    startedAtIso,
    startedAtMs,
    logStream,
  } = setup;

  params.mockCliServer.bind({
    conversationId,
    handlers: internals.getMockHandlers(),
    emitCliMock: internals.emitCliMock,
  });

  const initialCursor = await ctx.getCursor();
  const subscription = startOutboundSubscription({
    accountId,
    conversationId,
    initialCursor,
    onMessage: internals.emitOutboundReceived,
  });

  let failure = (await executeScenario(params.scenarioId, ctx)).failure;

  await subscription.stop();
  params.mockCliServer.release();

  if (!failure) {
    const promoted = promoteCliMockFailure(internals);
    if (promoted) failure = promoted;
  }

  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;
  const finishedAtIso = new Date(finishedAtMs).toISOString();

  const { entries, judgeUsages, result } = internals.finalize({ failure });
  await closeStream(logStream);

  await waitForGatewayUsage({ conversationId, startedAtIso });
  const { cost: gatewayCostUsd, turns: gatewayTurns } = readGatewayCostFor({
    startTsIso: startedAtIso,
    conversationId,
  });
  const judgeUsd = judgeUsages.reduce((sum, u) => sum + judgeCostUsd(u), 0);

  const agentCalls = parseAgentToolCalls({ conversationId, startedAtIso });
  pairAgentCallsWithCliMocks(agentCalls, entries);
  if (agentCalls.length === 0 && !gatewayLogExists()) {
    entries.push({
      seq: entries.length,
      ts: finishedAtIso,
      kind: "scenarioLog",
      message: `agentToolCall parsing skipped: ${GATEWAY_LOG_PATH} not found`,
    });
  }

  const merged = mergeTimeline(entries, agentCalls);
  const report: ScenarioReport = {
    schemaVersion: 1,
    scenario: params.scenarioId,
    channel: params.channel,
    conversationId,
    accountId,
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationMs,
    result,
    entries: merged,
    cost: {
      gatewayUsd: gatewayCostUsd,
      judgeUsd,
      totalUsd: gatewayCostUsd + judgeUsd,
      gatewayTurns,
    },
  };
  const finalOutDir = writeReportArtifacts(outDir, result.verdict, report);

  console.log(
    `[${params.channel}] ${params.scenarioId} ${result.verdict} in ${durationMs}ms — ${finalOutDir}`,
  );
  return {
    scenarioId: params.scenarioId,
    channel: params.channel,
    conversationId,
    verdict: result.verdict,
    durationMs,
    outDir: finalOutDir,
    judgeUsages,
    gatewayCostUsd,
    gatewayTurns,
  };
}

interface RunSetup {
  ctx: ScenarioContext;
  internals: ScenarioInternals;
  outDir: string;
  conversationId: string;
  accountId: ChannelId;
  startedAtIso: string;
  startedAtMs: number;
  logStream: ReturnType<typeof createWriteStream>;
}

function setupRun(params: RunOneParams): RunSetup {
  const conversationId = `${params.scenarioId}-${params.channel}-${shortRand()}`;
  const accountId: ChannelId = params.channel;
  const iterSuffix =
    params.iterations > 1
      ? `-${String(params.iteration).padStart(params.iterationWidth, "0")}`
      : "";
  const leaf = `${params.scenarioId}-${params.channel}${iterSuffix}`;
  const outDir = join(ARTIFACTS_ROOT, params.baseStamp, leaf);
  mkdirSync(outDir, { recursive: true });

  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const logStream = createWriteStream(join(outDir, "scenario-log.jsonl"), { flags: "a" });
  const emitSink = (entry: ReportEntry) => {
    logStream.write(`${JSON.stringify(entry)}\n`);
  };
  const { ctx, internals } = createContext({ channel: params.channel, conversationId, emitSink });
  return {
    ctx,
    internals,
    outDir,
    conversationId,
    accountId,
    startedAtIso,
    startedAtMs,
    logStream,
  };
}

interface OutboundSubscription {
  stop(): Promise<void>;
}

interface BusOutboundEvent {
  kind: string;
  message: { conversation: { id: string } } & Parameters<
    ScenarioInternals["emitOutboundReceived"]
  >[0];
}

function startOutboundSubscription(params: {
  accountId: ChannelId;
  conversationId: string;
  initialCursor: number;
  onMessage: (m: Parameters<ScenarioInternals["emitOutboundReceived"]>[0]) => void;
}): OutboundSubscription {
  const abort = new AbortController();
  const done = (async () => {
    let cursor = params.initialCursor;
    while (!abort.signal.aborted) {
      let result: Awaited<ReturnType<typeof pollQaBus>>;
      try {
        result = await pollQaBus({
          baseUrl: BUS_URL,
          accountId: params.accountId,
          cursor,
          timeoutMs: 1000,
        });
      } catch {
        if (abort.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      cursor = result.cursor;
      for (const e of result.events as BusOutboundEvent[]) {
        if (e.kind !== "outbound-message" && e.kind !== "message-edited") continue;
        if (e.message.conversation.id !== params.conversationId) continue;
        params.onMessage(e.message);
      }
    }
  })();
  return {
    stop: async () => {
      abort.abort();
      await done.catch(() => {});
    },
  };
}

async function executeScenario(
  scenarioId: string,
  ctx: ScenarioContext,
): Promise<{ failure: ScenarioFailure | undefined }> {
  try {
    const mod = await import(`${SCENARIOS_ROOT}/${scenarioId}.ts`);
    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new Error(`scenario ${scenarioId} has no default export function`);
    }
    await fn(ctx);
    return { failure: undefined };
  } catch (err) {
    const e = err as Error;
    const isAssertion = e?.name === "AssertionError";
    return {
      failure: {
        name: e?.name ?? "Error",
        message: e?.message ?? String(err),
        stack: e?.stack,
        source: isAssertion ? "assertion" : "scenarioThrow",
      },
    };
  }
}

function promoteCliMockFailure(internals: ScenarioInternals): ScenarioFailure | undefined {
  const { entries } = internals.peekEntries();
  for (const e of entries) {
    if (e.kind !== "cliMock") continue;
    const err = e.call.handlerError;
    if (!err) continue;
    return { name: err.name, message: err.message, stack: err.stack, source: "cliMock" };
  }
  return;
}

/**
 * Best-effort: pair each agent tool call that shelled out to a mocked CLI
 * with the corresponding cliMock entry (matched in order of occurrence) and
 * attach the real ts as `inferredStartedAt`.
 */
function pairAgentCallsWithCliMocks(agentCalls: AgentToolCall[], entries: ReportEntry[]): void {
  const cliMockQueues = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== "cliMock") continue;
    const q = cliMockQueues.get(e.call.cli) ?? [];
    q.push(e.ts);
    cliMockQueues.set(e.call.cli, q);
  }
  for (const call of agentCalls) {
    const cli = leadingCli(call.input);
    if (!cli) continue;
    const q = cliMockQueues.get(cli);
    if (!q || q.length === 0) continue;
    call.inferredStartedAt = q.shift();
  }
}

function leadingCli(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd !== "string") return;
  const stripped = cmd.replace(/^(?:\s*cd\s+[^&;|]+(?:&&|;|\|\|)\s*)+/, "");
  const m = stripped.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([A-Za-z0-9_./-]+)/);
  if (!m) return;
  return m[1].split("/").pop();
}

/**
 * Merge live entries with parsed agent tool calls, sort by ts, re-assign seq.
 * agentToolCall entries carry a synthetic end-of-turn ts (gateway log has no
 * per-tool ts); tie-break them before sibling live entries so the tool call
 * appears before its observed side effects.
 */
function mergeTimeline(entries: ReportEntry[], agentCalls: AgentToolCall[]): ReportEntry[] {
  const agentEntries: AgentToolCallEntry[] = agentCalls.map((call) => ({
    seq: -1,
    ts: call.startedAt,
    kind: "agentToolCall",
    call,
  }));
  const merged: ReportEntry[] = [...entries, ...agentEntries].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return kindOrder(a.kind) - kindOrder(b.kind);
  });
  for (let i = 0; i < merged.length; ++i) merged[i].seq = i;
  return merged;
}

function kindOrder(k: ReportEntry["kind"]): number {
  return k === "agentToolCall" ? 0 : 1;
}

function writeReportArtifacts(
  outDir: string,
  status: "pass" | "fail",
  report: ScenarioReport,
): string {
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const renamed = `${outDir}-${status.toUpperCase()}`;
  try {
    renameSync(outDir, renamed);
    return renamed;
  } catch (err) {
    console.warn(`runner: failed to rename ${outDir} -> ${renamed}:`, err);
    return outDir;
  }
}

function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
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

function printSummary(aggregates: PairAggregate[], baseStamp: string): void {
  console.log("");
  console.log("Summary:");
  for (const a of aggregates) {
    const passed = a.passCount === a.runCount && a.stoppedAfter === undefined;
    const verdict = (passed ? "PASS" : "FAIL").padEnd(4, " ");
    const counts = `${a.passCount}/${a.runCount}`.padStart(7, " ");
    const trailer =
      a.stoppedAfter !== undefined ? `  (stopped after ${a.stoppedAfter} failures)` : "";
    console.log(
      `  ${verdict}  ${a.channel.padEnd(12, " ")}  ${a.scenarioId.padEnd(40, " ")}  ${counts}  in ${a.durationSumMs}ms${trailer}`,
    );
  }
  console.log("");
  console.log("Artifacts:");
  console.log(`  ${join(ARTIFACTS_ROOT, baseStamp)}`);
}

function printTotalCost(results: TaskResult[]): void {
  const judgeCost = results
    .flatMap((r) => r.judgeUsages)
    .reduce((sum, u) => sum + judgeCostUsd(u), 0);
  const gatewayCost = results.reduce((sum, r) => sum + r.gatewayCostUsd, 0);
  const gatewayTurns = results.reduce((sum, r) => sum + r.gatewayTurns, 0);
  const totalCost = gatewayCost + judgeCost;
  console.log("");
  console.log(
    `Total LLM cost: $${totalCost.toFixed(4)} (gateway: $${gatewayCost.toFixed(4)} over ${gatewayTurns} turns, judge: $${judgeCost.toFixed(4)})`,
  );
}

function anyPairFailed(aggregates: PairAggregate[]): boolean {
  return aggregates.some((a) => a.passCount !== a.runCount || a.stoppedAfter !== undefined);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("runner crash:", err);
    process.exit(1);
  });
}
