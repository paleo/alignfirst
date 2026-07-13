/**
 * Scenario report typing for openclaw-test.
 *
 * Two artifacts per scenario run, under `<OPENCLAW_TEST_ARTIFACTS_DIR>/<baseStamp>/<scenario>-<channel>[-iter<n>]/`:
 *
 *   - `scenario-log.jsonl` — live append, one `ReportEntry` per line, written as
 *                            things happen. Survives runner crash / hang.
 *   - `report.json`        — final `ScenarioReport`, written once at end.
 *
 * `report.json` carries the same entries as `scenario-log.jsonl`, plus terminal
 * data only computable at the end (status, durationMs, finishedAt, parsed
 * agentToolCalls, cost).
 *
 * Each agent or scenario action is one entry. Assertions, scenario-log notes,
 * and failures about that action live as nested fields on the entry, not as
 * separate entries. Free-standing `scenarioLog` entries are the fallback for
 * `ctx.log(...)` calls that are not bound to an action.
 */

import type { Readable, Writable } from "node:stream";

export interface ScenarioReport {
  schemaVersion: 4;
  scenario: string;
  channel: ChannelId;
  model: string;
  conversationId: string;
  accountId: string;

  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cost: CostBreakdown;

  result: ScenarioResult;
  entries: ReportEntry[];
}

export type ScenarioResult = PassScenarioResult | FailScenarioResult;
export type FailScenarioResult = FailedEntryScenarioResult | ErrorScenarioResult;

export interface PassScenarioResult {
  verdict: "pass";
}

export interface FailedEntryScenarioResult {
  verdict: "fail";
  cause: "failedEntry";
  /** Stable entry identifier shared by `scenario-log.jsonl` and `report.json`. */
  entrySeq: number;
  message: string;
}

export interface ErrorScenarioResult {
  verdict: "fail";
  cause: "error";
  source: "assertion" | "judge" | "cliMock" | "timeout" | "scenarioThrow" | "runner";
  errorName: string;
  message: string;
  stack?: string;
}

export type ChannelId = string;

export type ReportEntry = ScenarioLogEntry | ActionEntry;

export type ActionEntry =
  | InboundSentEntry
  | OutboundReceivedEntry
  | CliMockEntry
  | AgentToolCallEntry;

export interface ReportEntryBase {
  ts: string;
  /**
   * Stable entry id shared across `scenario-log.jsonl` and `report.json`. In the
   * jsonl it matches the line's emission order; in `report.json` entries are
   * sorted by `ts` so `entrySeq` is not array position — it stays a cross-file
   * reference.
   */
  entrySeq: number;
}

export interface ActionEntryBase extends ReportEntryBase {
  scenarioLog?: ScenarioLogNote;
  assertions?: AssertionRecord[];
  failure?: ScenarioFailure;
}

export interface ScenarioLogNote {
  label?: string;
  ts: string;
  extra?: unknown;
}

export interface ScenarioLogEntry extends ReportEntryBase {
  kind: "scenarioLog";
  message: string;
}

export interface InboundSentEntry extends ActionEntryBase {
  kind: "inboundSent";
  messageId: string;
  text: string;
  senderId: string;
  senderName?: string;
  threadId?: string;
}

export interface OutboundReceivedEntry extends ActionEntryBase {
  kind: "outboundReceived";
  messageId: string;
  text: string;
  threadId?: string;
}

export interface CliMockEntry extends ActionEntryBase {
  kind: "cliMock";
  call: CliMockCall;
}

export interface AgentToolCallEntry extends ActionEntryBase {
  kind: "agentToolCall";
  call: AgentToolCall;
}

export type AssertionRecord =
  | { label: string; ok: true; extra?: unknown }
  | { label: string; ok: false; detail: string; extra?: unknown };

export interface CliMockCall {
  cli: "git" | "npm" | "pnpm" | "yarn" | "claude" | (string & {});
  argv: string[];
  cwd: string;
  stdin: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  durationMs: number;
  handlerError?: { name: string; message: string; stack?: string };
}

export interface AgentToolCall {
  toolName: string;
  toolUseId: string;
  /**
   * `sessionKey` of the trajectory snapshot the call was collected from — the
   * OpenClaw session that made it (e.g. channel vs per-thread session).
   */
  sessionKey?: string;
  input: unknown;
  result?: {
    isError: boolean;
    /**
     * Full tool result. Always present in `scenario-log.jsonl`. In `report.json`,
     * replaced by `truncatedContent` when truncatable: a string longer than 60
     * chars, or a `read` call's text content blocks (the file is identified by
     * `input` and kept in full in the jsonl).
     */
    content?: unknown;
    /** Only in `report.json`: rtrimmed first 60 chars + `…` of the truncatable text. */
    truncatedContent?: string;
  };
  startedAt: string;
  /**
   * Best-effort estimate of when the tool call actually started, inferred by
   * matching the call's leading CLI against an in-order `cliMock` entry from
   * the same scenario. `startedAt` carries the synthetic end-of-turn ts
   * because the gateway log has no per-tool timestamp; this field, when
   * present, lets readers see roughly when the call happened. Not used for
   * `entries` ordering.
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
  agentUsd: number;
  judgeUsd: number;
  totalUsd: number;
  agentTurns: number;
}

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

/**
 * Patch describing the augmentation of an already-emitted entry. Carries only
 * the new nested field so the live `scenario-log.jsonl` need not re-serialize
 * the entry's full text/metadata on every assertion or annotation.
 */
export type AugmentPatch =
  | { kind: "scenarioLog"; scenarioLog: ScenarioLogNote }
  | { kind: "assertion"; assertion: AssertionRecord }
  | { kind: "failure"; failure: ScenarioFailure };

export type SinkEvent =
  | { type: "entry"; entry: ReportEntry }
  | { type: "augment"; entrySeq: number; patch: AugmentPatch };

/**
 * Callback the runner passes into `createContext` so live records can be
 * appended to `scenario-log.jsonl` as they happen. First emission of an entry
 * is `type: "entry"`. Subsequent nested-field additions (assertions, failure,
 * scenarioLog) are `type: "augment"` with only the patch — readers reconstruct
 * full state by folding augments onto entries by `seq`.
 */
export type EmitSink = (event: SinkEvent) => void;
