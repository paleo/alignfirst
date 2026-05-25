import { pollQaBus } from "@paleo/openclaw-channel-mock-core";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeCellResult } from "./cell-result.js";
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
import { startMockCliServer } from "./mock-cli-server.js";
import type {
  AgentToolCall,
  AgentToolCallEntry,
  ReportEntry,
  ScenarioFailure,
  ScenarioReport,
} from "./report.js";
import { parseArgs, type RunnerArgs } from "./runner-args.js";

const ARTIFACTS_ROOT = process.env.QA_ARTIFACTS_ROOT ?? "/opt/qa-artifacts";
const SCENARIOS_ROOT = process.env.QA_SCENARIOS_ROOT ?? "/opt/qa-src/scenarios";
const BUS_URL = process.env.QA_BUS_URL ?? "http://bus:43123";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  console.log(
    `runner: scenario=${args.scenario} channel=${args.channel} iter=${args.iterationIndex}/${args.iterationWidth}`,
  );
  const exitCode = await runCell(args);
  process.exit(exitCode);
}

async function runCell(args: RunnerArgs): Promise<number> {
  const mockCliServer = startMockCliServer();
  try {
    const setup = setupRun(args);
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

    mockCliServer.bind({
      conversationId,
      handlers: internals.getMockHandlers(),
      emitCliMock: internals.emitCliMock,
      isScenarioEnded: () => internals.isScenarioEnded(),
    });

    const initialCursor = await ctx.getCursor();
    const subscription = startOutboundSubscription({
      accountId,
      conversationId,
      initialCursor,
      onMessage: internals.emitOutboundReceived,
    });

    const { failure } = await executeScenario(args.scenario, ctx);

    await subscription.stop();
    await mockCliServer.release();

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
      scenario: args.scenario,
      channel: args.channel,
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

    // Write the cell record BEFORE the artifact-dir rename, to a stable sibling path.
    const leafBase = basename(outDir);
    const resultsPath = join(args.resultsDir, `${leafBase}.json`);
    mkdirSync(args.resultsDir, { recursive: true });

    const finalOutDir = writeReportArtifacts(outDir, result.verdict, report);

    writeCellResult(resultsPath, {
      schemaVersion: 1,
      scenarioId: args.scenario,
      channel: args.channel,
      iterationIndex: args.iterationIndex,
      verdict: result.verdict,
      durationMs,
      conversationId,
      artifactDirName: basename(finalOutDir),
      gatewayCostUsd,
      gatewayTurns,
      judgeUsd,
      judgeUsages,
    });

    console.log(
      `[${args.channel}] ${args.scenario} ${result.verdict} in ${durationMs}ms — ${finalOutDir}`,
    );
    return result.verdict === "pass" ? 0 : 1;
  } finally {
    await mockCliServer.close();
  }
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

function setupRun(args: RunnerArgs): RunSetup {
  const conversationId = `${args.scenario}-${args.channel}-${shortRand()}`;
  const accountId: ChannelId = args.channel;
  const iterSuffix =
    args.iterationWidth > 0
      ? `-${String(args.iterationIndex).padStart(args.iterationWidth, "0")}`
      : "";
  const leaf = `${args.scenario}-${args.channel}${iterSuffix}`;
  const outDir = join(ARTIFACTS_ROOT, args.baseStamp, leaf);
  mkdirSync(outDir, { recursive: true });

  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const logStream = createWriteStream(join(outDir, "scenario-log.jsonl"), { flags: "a" });
  const emitSink = (entry: ReportEntry) => {
    logStream.write(`${JSON.stringify(entry)}\n`);
  };
  const { ctx, internals } = createContext({ channel: args.channel, conversationId, emitSink });
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

function shortRand(): string {
  return randomBytes(3).toString("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("runner crash:", err);
    process.exit(1);
  });
}
