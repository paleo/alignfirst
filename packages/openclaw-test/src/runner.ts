import { pollQaBus } from "@paleo/openclaw-channel-mock-core";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cellLeafName, writeCellResult } from "./cell-result.js";
import {
  type ChannelId,
  createContext,
  type ScenarioContext,
  type ScenarioInternals,
} from "./context.js";
import { judgeCostUsd } from "./cost.js";
import {
  parseAgentToolCalls,
  readTrajectoryCostFor,
  TRAJECTORY_DIR,
  trajectoryDirExists,
  waitForTrajectoryUsage,
} from "./trajectory-log.js";
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

    await waitForTrajectoryUsage({ conversationId, startedAtIso });
    const { cost: agentCostUsd, turns: agentTurns } = readTrajectoryCostFor({
      startTsIso: startedAtIso,
      conversationId,
    });
    const judgeUsd = judgeUsages.reduce((sum, u) => sum + judgeCostUsd(u), 0);

    const agentCalls = parseAgentToolCalls({ conversationId, startedAtIso });
    pairAgentCallsWithCliMocks(agentCalls, entries);
    if (agentCalls.length === 0 && !trajectoryDirExists()) {
      entries.push({
        entrySeq: entries.length,
        ts: finishedAtIso,
        kind: "scenarioLog",
        message: `agentToolCall parsing skipped: ${TRAJECTORY_DIR} not found`,
      });
    }

    const agentEntries = buildAgentToolCallEntries(agentCalls, entries.length);
    appendAgentCallsToLog(logStream, agentEntries);
    await closeStream(logStream);
    const merged = mergeTimeline(entries, agentEntries);
    const report: ScenarioReport = {
      schemaVersion: 4,
      scenario: args.scenario,
      channel: args.channel,
      model: args.modelId,
      conversationId,
      accountId,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
      durationMs,
      result,
      entries: merged.map(prepareEntryForReport),
      cost: {
        agentUsd: agentCostUsd,
        judgeUsd,
        totalUsd: agentCostUsd + judgeUsd,
        agentTurns,
      },
    };

    // Write the cell record BEFORE the artifact-dir rename, to a stable sibling path.
    const leafBase = basename(outDir);
    const resultsPath = join(args.resultsDir, `${leafBase}.json`);
    mkdirSync(args.resultsDir, { recursive: true });

    const finalOutDir = writeReportArtifacts(outDir, result.verdict, report);

    writeCellResult(resultsPath, {
      schemaVersion: 3,
      scenarioId: args.scenario,
      channel: args.channel,
      model: args.modelId,
      iterationIndex: args.iterationIndex,
      verdict: result.verdict,
      durationMs,
      conversationId,
      artifactDirName: basename(finalOutDir),
      agentCostUsd,
      agentTurns,
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
  const leaf = cellLeafName({
    scenarioId: args.scenario,
    modelId: args.modelId,
    channel: args.channel,
    iterationIndex: args.iterationIndex,
    iterationWidth: args.iterationWidth,
  });
  const outDir = join(ARTIFACTS_ROOT, args.baseStamp, leaf);
  mkdirSync(outDir, { recursive: true });

  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const logStream = createWriteStream(join(outDir, "scenario-log.jsonl"), { flags: "a" });
  const emitSink: EmitSink = (event) => {
    if (event.type === "entry") {
      logStream.write(`${JSON.stringify(event.entry)}\n`);
    } else {
      logStream.write(`${JSON.stringify({ entrySeq: event.entrySeq, augment: event.patch })}\n`);
    }
  };
  const { ctx, internals } = createContext({
    channel: args.channel,
    conversationId,
    startedAtIso,
    emitSink,
  });
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
 * Build agentToolCall entries with stable `entrySeq` values continuing the live
 * jsonl emission order. These values are shared by both artifact files —
 * `scenario-log.jsonl` (appended at the tail in ts order) and `report.json`
 * (interleaved with live entries by ts).
 */
function buildAgentToolCallEntries(
  agentCalls: AgentToolCall[],
  liveEntryCount: number,
): AgentToolCallEntry[] {
  const sorted = [...agentCalls].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  return sorted.map((call, i) => ({
    entrySeq: liveEntryCount + i,
    ts: call.startedAt,
    kind: "agentToolCall",
    call,
  }));
}

/**
 * Append parsed agentToolCall entries to the tail of `scenario-log.jsonl` in
 * ts order. Their `entrySeq` values continue past the live entries' and are the
 * same values used in `report.json` — readers can cross-reference by `entrySeq`.
 */
function appendAgentCallsToLog(
  logStream: ReturnType<typeof createWriteStream>,
  agentEntries: AgentToolCallEntry[],
): void {
  for (const entry of agentEntries) {
    logStream.write(`${JSON.stringify(entry)}\n`);
  }
}

/**
 * Interleave live entries with agentToolCall entries by `ts` for `report.json`.
 * Entries keep their original `entrySeq`; the array order is ts, so iterating
 * gives the unified timeline while `entrySeq` remains a cross-file identifier.
 */
function mergeTimeline(entries: ReportEntry[], agentEntries: AgentToolCallEntry[]): ReportEntry[] {
  return [...entries, ...agentEntries].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return kindOrder(a.kind) - kindOrder(b.kind);
  });
}

function kindOrder(k: ReportEntry["kind"]): number {
  return k === "agentToolCall" ? 0 : 1;
}

const REPORT_CONTENT_TRUNCATE_AT = 60;

/**
 * Replace bulky `content` with `truncatedContent` for `report.json` only. The
 * original entry (already streamed to `scenario-log.jsonl`) keeps the full
 * content; this returns a shallow-cloned `agentToolCall` entry with the
 * truncated `result`.
 */
function prepareEntryForReport(entry: ReportEntry): ReportEntry {
  if (entry.kind !== "agentToolCall" || !entry.call.result) return entry;
  const text = truncatableResultText(entry.call.toolName, entry.call.result.content);
  if (text === undefined || text.length <= REPORT_CONTENT_TRUNCATE_AT) return entry;
  const truncatedContent = `${text.slice(0, REPORT_CONTENT_TRUNCATE_AT).replace(/\s+$/, "")}…`;
  return {
    ...entry,
    call: {
      ...entry.call,
      result: { isError: entry.call.result.isError, truncatedContent },
    },
  };
}

/**
 * The string to truncate for `report.json`, or `undefined` to keep `content`
 * as-is. The `read` tool returns its file content as text blocks rather than a
 * string, so its text is joined — the file is identified by `input`, so the
 * report needs no more than a preview.
 */
function truncatableResultText(toolName: string, content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (toolName === "read") return readBlocksText(content);
  return;
}

function readBlocksText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return;
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
