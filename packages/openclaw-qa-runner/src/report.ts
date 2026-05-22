/**
 * Scenario report typing for QA harness.
 *
 * Two artifacts per scenario run, under `qa/artifacts/<baseStamp>-<scenario>-<channel>/`:
 *
 *   - `events.jsonl`  — live append, one `ReportEvent` per line, written as things happen.
 *                       Survives runner crash / hang.
 *   - `report.json`   — final `ScenarioReport`, written once at end. Supersedes the old
 *                       `report.md` + `summary.json` pair (both removed).
 *
 * `report.json` carries the same events as `events.jsonl`, plus terminal data only
 * computable at the end (status, durationMs, finishedAt, parsed agentToolCalls, cost).
 */

import type { Readable, Writable } from "node:stream";

// ─── Top-level report ─────────────────────────────────────────────────────────

export interface ScenarioReport {
  schemaVersion: 1;
  scenario: string;
  channel: ChannelId;
  conversationId: string;
  accountId: string;

  status: "pass" | "fail";
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
  durationMs: number;

  events: ReportEvent[];

  failure?: ScenarioFailure;
  cost: CostBreakdown;
}

export type ChannelId = "discord-mock" | "slack-mock";

// ─── Event timeline (also the `events.jsonl` line type) ───────────────────────

export type ReportEvent =
  | LogEvent
  | InboundSentEvent
  | OutboundReceivedEvent
  | AssertionEvent
  | JudgeEvent
  | CliMockEvent
  | AgentToolCallEvent
  | FailureEvent;

export interface ReportEventBase {
  ts: string; // ISO-8601
  seq: number; // monotonic per scenario, starting at 0
}

export interface LogEvent extends ReportEventBase {
  kind: "log";
  message: string;
}

export interface InboundSentEvent extends ReportEventBase {
  kind: "inboundSent";
  messageId: string;
  text: string;
  senderId: string;
  senderName?: string;
  threadId?: string;
}

export interface OutboundReceivedEvent extends ReportEventBase {
  kind: "outboundReceived";
  messageId: string;
  text: string;
  threadId?: string;
}

export interface AssertionEvent extends ReportEventBase {
  kind: "assertion";
  record: AssertionRecord;
}

export interface JudgeEvent extends ReportEventBase {
  kind: "judge";
  record: JudgeCallRecord;
}

export interface CliMockEvent extends ReportEventBase {
  kind: "cliMock";
  call: CliMockCall;
}

export interface AgentToolCallEvent extends ReportEventBase {
  kind: "agentToolCall";
  call: AgentToolCall;
}

export interface FailureEvent extends ReportEventBase {
  kind: "failure";
  failure: ScenarioFailure;
}

// ─── Sub-records ──────────────────────────────────────────────────────────────

export type AssertionRecord =
  | { label: string; ok: true }
  | { label: string; ok: false; detail: string };

export interface JudgeCallRecord {
  label: string;
  verdict: "pass" | "fail";
  reasoning: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
}

/**
 * One mocked-CLI invocation: the agent shelled out, our shim routed the call to the
 * scenario's registered handler, and we captured the round-trip. Emitted by plan A5.
 */
export interface CliMockCall {
  cli: "git" | "npm" | "pnpm" | "yarn" | "claude" | (string & {});
  argv: string[]; // does not include argv[0]
  cwd: string;
  stdin: string; // captured if the agent piped input; "" otherwise
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  durationMs: number;
  handlerError?: { name: string; message: string; stack?: string };
}

/**
 * One tool call made by the OpenClaw agent during the scenario, parsed from the
 * gateway's `anthropic-payload.jsonl` (filtered by `conversationId`).
 *
 * Best-effort: depends on `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` (QA runs force it on).
 * If the log is absent, this list is empty and a note lands in `events`.
 */
export interface AgentToolCall {
  toolName: string;
  toolUseId: string;
  input: unknown;
  result?: { isError: boolean; content: unknown };
  startedAt: string;
  /**
   * Best-effort estimate of when the tool call actually started, inferred by
   * matching the call's leading CLI against an in-order `cliMock` event from
   * the same scenario. `startedAt` carries the synthetic end-of-turn ts
   * because the gateway log has no per-tool timestamp; this field, when
   * present, lets readers see roughly when the call happened. Not used for
   * `events` ordering.
   */
  inferredStartedAt?: string;
  turn?: number;
}

export interface ScenarioFailure {
  name: string;
  message: string;
  stack?: string;
  source: "assertion" | "judge" | "cliMock" | "timeout" | "scenarioThrow" | "runner";
}

export interface CostBreakdown {
  gatewayUsd: number;
  judgeUsd: number;
  totalUsd: number;
  gatewayTurns: number;
}

// ─── Scenario-side mock-CLI registration API (used by plan A5) ────────────────

/**
 * Handler a scenario registers for a mocked CLI. Implemented by plan A5.
 *
 *   ctx.mockCli("git", async ({ argv, cwd, stdin, stdout, stderr }) => {
 *     stdout.write("ok\n");
 *     if (argv[0] === "push") return 1;
 *     // returning undefined ⇒ exit code 0
 *   });
 *
 * If the agent invokes a CLI for which no handler is registered, the scenario fails
 * with `source: "cliMock"` and `message: "unexpected call to <cli>"`.
 */
export interface CliMockHandlerArgs {
  argv: string[];
  cwd: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export type CliMockHandler = (
  args: CliMockHandlerArgs,
) => number | undefined | Promise<number | undefined>;

// ─── Runtime helpers (shared between context.ts and runner.ts) ────────────────

/**
 * The callback `runner.ts` passes into `createContext` so live events can be
 * appended to `events.jsonl` as they happen. Receives the already-sealed event
 * (`seq` + `ts` set).
 */
export type EmitSink = (event: ReportEvent) => void;
