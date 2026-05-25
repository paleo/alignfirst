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
  EmitSink,
  ReportEntry,
  ScenarioFailure,
  ScenarioReport,
} from "./report.js";
import { parseArgs, type RunnerArgs } from "./runner-args.js";

const ARTIFACTS_ROOT = process.env.OPENCLAW_TEST_ARTIFACTS_DIR ?? "/opt/openclaw-test/artifacts";
const SCENARIOS_ROOT =
  process.env.OPENCLAW_TEST_SCENARIOS_DIR ?? "/opt/openclaw-test/src/scenarios";
const BUS_URL = process.env.OPENCLAW_TEST_BUS_URL ?? "http://bus:43123";

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

    // Snapshot live-entry seqs (= their position in `scenario-log.jsonl`)
    // before mergeTimeline mutates them to the merged-by-ts ordering used in
    // `report.json`.
    const liveSeqByRef = new Map<ReportEntry, number>();
    for (const e of entries) liveSeqByRef.set(e, e.seq);
    const merged = mergeTimeline(entries, agentCalls);
    const liveSeqToMerged = new Map<number, number>();
    for (const e of merged) {
      const oldSeq = liveSeqByRef.get(e);
      if (oldSeq !== undefined) liveSeqToMerged.set(oldSeq, e.seq);
    }
    attachResultMergedSeq(result, liveSeqToMerged);
    appendAgentCallsToLog(logStream, merged, entries);
    await closeStream(logStream);
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
  const emitSink: EmitSink = (event) => {
    if (event.type === "entry") {
      logStream.write(`${JSON.stringify(event.entry)}\n`);
    } else {
      logStream.write(`${JSON.stringify({ seq: event.seq, augment: event.patch })}\n`);
    }
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

export function leadingCli(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd !== "string") return;
  const stripped = cmd.replace(/^(?:\s*cd\s+[^&;|]+(?:&&|;|\|\|)\s*)+/, "");
  const m = stripped.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([A-Za-z0-9_./-]+)/);
  if (!m) return;
  // Reject bare env-assignments (e.g. `FOO=bar` alone): the capture class
  // stops at `=`, so we'd otherwise return "FOO" as if it were a command.
  if (stripped[m[0].length] === "=") return;
  return m[1].split("/").pop();
}

/**
 * Append parsed agentToolCall entries to the tail of `scenario-log.jsonl`
 * with seqs continuing after the live entries. `scenario-log.jsonl` stays
 * append-only and reflects the streaming order; `report.json` re-interleaves
 * the same entries by `ts` with its own seqs.
 */
function appendAgentCallsToLog(
  logStream: ReturnType<typeof createWriteStream>,
  merged: ReportEntry[],
  liveEntries: ReportEntry[],
): void {
  const tail = merged
    .filter((e): e is AgentToolCallEntry => e.kind === "agentToolCall")
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let seq = liveEntries.length;
  for (const entry of tail) {
    const out: AgentToolCallEntry = { ...entry, seq };
    logStream.write(`${JSON.stringify(out)}\n`);
    seq += 1;
  }
}

/**
 * After `mergeTimeline`, the failed entry has been mutated to its merged
 * `seq`. Promote that as `entrySeq` (the canonical `report.json` index) and
 * keep the original live-entry seq as `scenarioLogEntrySeq` so consumers can
 * still locate the entry in `scenario-log.jsonl`.
 */
function attachResultMergedSeq(
  result: ScenarioReport["result"],
  liveSeqToMerged: Map<number, number>,
): void {
  if (result.verdict !== "fail" || result.cause !== "failedEntry") return;
  const mapped = liveSeqToMerged.get(result.entrySeq);
  if (mapped === undefined) return;
  const prefix = `[entry #${result.entrySeq}]`;
  if (result.message.startsWith(prefix)) {
    result.message = `[entry #${mapped}]${result.message.slice(prefix.length)}`;
  }
  result.entrySeq = mapped;
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
