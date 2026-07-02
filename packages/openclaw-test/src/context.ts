import {
  getQaBusState,
  injectQaBusInboundMessage,
  pollQaBus,
  type QaBusConversation,
  type QaBusMessage,
  type QaBusPollResult,
} from "@paleo/openclaw-channel-mock-core";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { judgeCostUsd } from "./cost.js";
import {
  judgeLLM,
  judgeLLMJson,
  judgeLLMRaw,
  type JudgeUsage,
  type JudgeVerdict,
  type JudgeVerdictJson,
  type JudgeVerdictRaw,
} from "./judge.js";
import type {
  ActionEntry,
  AgentToolCall,
  AssertionRecord,
  AugmentPatch,
  ChannelId,
  CliMockCall,
  CliMockEntry,
  CliMockHandler,
  EmitSink,
  ErrorScenarioResult,
  InboundSentEntry,
  OutboundReceivedEntry,
  ReportEntry,
  ScenarioFailure,
  ScenarioLogNote,
  ScenarioResult,
} from "./report.js";
import { parseAgentToolCalls } from "./trajectory-log.js";

const BUS_URL = process.env.OPENCLAW_TEST_BUS_URL ?? "http://bus:43123";

export type { ChannelId } from "./report.js";
export type Conversation = QaBusConversation;
export type BusMessage = QaBusMessage;

export interface PollResult {
  messages: BusMessage[];
  nextCursor: number;
}

export interface SendInboundResult {
  message: BusMessage;
  entry: InboundSentEntry;
}

export interface WaitForOutboundResult {
  match: BusMessage;
  entry: OutboundReceivedEntry;
  nextCursor: number;
}

export type MockCliRegisterMode = "register" | "replace" | "ifAbsent";

export interface MockCliRegisterOptions {
  /**
   * - `"register"` (default): throws if a handler is already registered for `name`.
   * - `"replace"`: overwrites the existing handler; throws if none was registered.
   * - `"ifAbsent"`: no-op if a handler is already registered.
   */
  mode?: MockCliRegisterMode;
}

export interface ScenarioContext {
  channel: ChannelId;
  conversationId: string;
  accountId: ChannelId;
  /**
   * The most recent agent-action entry (`outboundReceived` / `cliMock` /
   * `agentToolCall`). Capture this synchronously after `await` resolves to
   * pin a handle to the action before any further awaits could overwrite it.
   * `inboundSent` is scenario-emitted and does not update this property.
   */
  readonly currentEntry: ActionEntry | undefined;
  /**
   * `true` once the scenario has called `markScenarioAsEnded`. After that, the
   * mock-cli server stops dispatching to registered handlers — any incoming
   * call (typically a lingering agent action firing after the verdict is in)
   * is answered with a "scenario ended" stub message and recorded as a
   * post-end cliMock entry that does **not** affect the result.
   */
  readonly isScenarioEnded: boolean;
  /**
   * Declare the scenario's verdict signals are all in. From this point on
   * the runner stops attributing tool-call failures to this scenario.
   * Optional `reason` is recorded in the scenarioLog (e.g. `"PASS"`).
   */
  markScenarioAsEnded(reason?: string): void;
  log(message: string): void;
  log(opts: { attachTo: ActionEntry; label?: string; extra?: unknown }): void;
  sendInbound(input: SendInboundInput): Promise<SendInboundResult>;
  poll(opts: { sinceCursor: number; timeoutMs?: number }): Promise<PollResult>;
  waitForOutbound(
    predicate: (m: BusMessage) => boolean,
    opts: WaitForOutboundOptions,
  ): Promise<WaitForOutboundResult>;
  expectNoOutbound(
    predicate: (m: BusMessage) => boolean,
    opts: { withinMs: number; sinceCursor: number },
  ): Promise<{ nextCursor: number }>;
  assertRegex(actual: string, pattern: RegExp, label: string): void;
  assertEqual<T>(actual: T, expected: T, label: string): void;
  assertLength(
    value: { length: number } | string | unknown[],
    expected: number,
    label: string,
  ): void;
  /**
   * Anthropic-direct judgement. The verdict is recorded as an `AssertionRecord`
   * on the `attachTo` action entry — usually the entry returned by
   * `waitForOutbound` / `sendInbound`, or a snapshot of `ctx.currentEntry`
   * taken right after the relevant `await` resolves.
   */
  judgeLLM(p: {
    attachTo: ActionEntry;
    message: string;
    rubric: string;
    label: string;
    maxTokens?: number;
  }): Promise<JudgeVerdict>;
  judgeLLMJson<T>(p: {
    message: string;
    prompt: string;
    returnType: string;
    label: string;
    maxTokens?: number;
  }): Promise<JudgeVerdictJson<T>>;
  judgeLLMRaw(p: { prompt: string; label: string; maxTokens?: number }): Promise<JudgeVerdictRaw>;
  getCursor(): Promise<number>;
  mockCli(name: string, handler: CliMockHandler, opts?: MockCliRegisterOptions): void;
  /**
   * Execute an arbitrary command inside the gateway container via the exec
   * watcher RPC. Always resolves once the wrapped command finishes (with its
   * exit code, stdout, and stderr — non-zero exits do NOT throw). Throws only
   * on transport failure or hard timeout (`timeoutMs + 5s` headroom for the
   * watcher to record a kill before this side gives up).
   */
  execInGateway(argv: string[], opts?: ExecInGatewayOptions): Promise<ExecInGatewayResult>;
  /**
   * Poll the trajectory log until an agent tool call matches `predicate`, then
   * record a passing `AssertionRecord` on the current entry and return the call.
   * On timeout, record a failing assertion and throw (hard-fail) — use it to
   * assert the agent took a specific action (read a file, ran a command).
   * Aggregates across all the conversation's sessions, so it sees thread and
   * subagent tool calls, and rides out the trajectory's flush latency.
   */
  waitForAgentToolCall(
    predicate: (call: AgentToolCall) => boolean,
    opts: WaitForAgentToolCallOptions,
  ): Promise<AgentToolCall>;
}

export interface WaitForAgentToolCallOptions {
  /** Assertion label recorded on the current entry. */
  label: string;
  /** Default 30_000. */
  timeoutMs?: number;
  /** Default 500. */
  pollMs?: number;
}

export interface WaitForOutboundOptions {
  sinceCursor: number;
  timeoutMs?: number;
  failFastUnmatchedOutbounds?: number | false;
  failFastCliMockGraceMs?: number | false;
}

export interface ExecInGatewayOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ExecInGatewayResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScenarioInternals {
  finalize(opts?: { failure?: ScenarioFailure }): {
    entries: ReportEntry[];
    judgeUsages: JudgeUsage[];
    result: ScenarioResult;
  };
  emitOutboundReceived(m: BusMessage): void;
  emitCliMock(call: CliMockCall): void;
  getMockHandlers(): Map<string, CliMockHandler>;
  peekEntries(): { entries: ReportEntry[] };
  isScenarioEnded(): boolean;
}

export interface SendInboundInput {
  senderId: string;
  senderName?: string;
  text: string;
  threadId?: string;
  conversation?: Conversation;
}

export class AssertionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AssertionError";
  }
}

export function createContext(params: {
  channel: ChannelId;
  conversationId: string;
  /** Scenario start time; bounds the trajectory window for `waitForAgentToolCall`. */
  startedAtIso?: string;
  emitSink?: EmitSink;
}): { ctx: ScenarioContext; internals: ScenarioInternals } {
  const { channel, conversationId, emitSink } = params;
  const startedAtIso = params.startedAtIso ?? new Date().toISOString();
  const accountId: ChannelId = channel;
  const entries: ReportEntry[] = [];
  const judgeUsages: JudgeUsage[] = [];
  const mockHandlers = new Map<string, CliMockHandler>();
  const outboundWaiters = new Map<string, (entry: OutboundReceivedEntry) => void>();
  const outboundByMessageId = new Map<string, OutboundReceivedEntry>();
  let nextEntrySeq = 0;
  let currentEntry: ActionEntry | undefined;
  let lastCliMock: { atMs: number; entry: CliMockEntry } | undefined;
  let scenarioEnded = false;

  const nextEntrySeqTs = (): { entrySeq: number; ts: string } => ({
    entrySeq: nextEntrySeq++,
    ts: new Date().toISOString(),
  });

  const emit = <T extends ReportEntry>(entry: T): T => {
    entries.push(entry);
    emitSink?.({ type: "entry", entry });
    return entry;
  };

  const emitAugment = (entrySeq: number, patch: AugmentPatch): void => {
    emitSink?.({ type: "augment", entrySeq, patch });
  };

  const setCurrentEntry = <T extends ActionEntry>(entry: T): T => {
    currentEntry = entry;
    if (entry.kind === "cliMock") {
      lastCliMock = { atMs: Date.now(), entry: entry as CliMockEntry };
    }
    return entry;
  };

  const emitOutboundReceived = (m: BusMessage): void => {
    const entry: OutboundReceivedEntry = {
      ...nextEntrySeqTs(),
      kind: "outboundReceived",
      messageId: m.id,
      text: m.text,
      ...(m.threadId !== undefined ? { threadId: m.threadId } : {}),
    };
    emit(entry);
    setCurrentEntry(entry);
    outboundByMessageId.set(m.id, entry);
    const waiter = outboundWaiters.get(m.id);
    if (waiter) {
      outboundWaiters.delete(m.id);
      waiter(entry);
    }
  };

  const emitCliMock = (call: CliMockCall): void => {
    const entry: CliMockEntry = { ...nextEntrySeqTs(), kind: "cliMock", call };
    emit(entry);
    setCurrentEntry(entry);
    if (call.handlerError) {
      const failure: ScenarioFailure = {
        name: call.handlerError.name,
        message: call.handlerError.message,
        ...(call.handlerError.stack ? { stack: call.handlerError.stack } : {}),
        source: "cliMock",
      };
      entry.failure = failure;
      emitAugment(entry.entrySeq, { kind: "failure", failure });
    }
  };

  const ctx: ScenarioContext = {
    channel,
    conversationId,
    accountId,
    get currentEntry() {
      return currentEntry;
    },
    get isScenarioEnded() {
      return scenarioEnded;
    },
    markScenarioAsEnded: (reason) => {
      if (scenarioEnded) return;
      scenarioEnded = true;
      const message =
        reason !== undefined && reason.length > 0 ? `scenario ended: ${reason}` : "scenario ended";
      emit({ ...nextEntrySeqTs(), kind: "scenarioLog", message });
    },
    log: ((arg: string | { attachTo: ActionEntry; label?: string; extra?: unknown }) => {
      if (typeof arg === "string") {
        emit({ ...nextEntrySeqTs(), kind: "scenarioLog", message: arg });
        return;
      }
      const note: ScenarioLogNote = {
        ts: new Date().toISOString(),
        label: arg.label,
        extra: arg.extra,
      };
      arg.attachTo.scenarioLog = note;
      emitAugment(arg.attachTo.entrySeq, { kind: "scenarioLog", scenarioLog: note });
    }) as ScenarioContext["log"],
    sendInbound: (input) => sendInbound({ emit, nextEntrySeqTs }, accountId, conversationId, input),
    poll: (opts) => poll(accountId, opts),
    waitForOutbound: (predicate, opts) =>
      waitForOutbound(
        {
          accountId,
          awaitEntry: (id) => awaitOutboundEntry(id),
          getLastCliMock: () => lastCliMock,
        },
        predicate,
        opts,
      ),
    expectNoOutbound: (predicate, opts) => expectNoOutbound(accountId, predicate, opts),
    assertRegex: (actual, pattern, label) =>
      assertRegex({ getCurrentEntry: () => currentEntry, emitAugment }, actual, pattern, label),
    assertEqual: (actual, expected, label) =>
      assertEqual({ getCurrentEntry: () => currentEntry, emitAugment }, actual, expected, label),
    assertLength: (value, expected, label) =>
      assertLength({ getCurrentEntry: () => currentEntry, emitAugment }, value, expected, label),
    judgeLLM: (p) => callJudgeVerdict({ emitAugment, judgeUsages }, p),
    judgeLLMJson: (p) => callJudgeJson(judgeUsages, p),
    judgeLLMRaw: (p) => callJudgeRaw(judgeUsages, p),
    getCursor,
    mockCli: (name, handler, opts) => registerMockCli(mockHandlers, name, handler, opts),
    execInGateway: (argv, opts) => execInGateway(argv, opts),
    waitForAgentToolCall: (predicate, opts) =>
      waitForAgentToolCall(
        { conversationId, startedAtIso, getCurrentEntry: () => currentEntry, emitAugment },
        predicate,
        opts,
      ),
  };

  const internals: ScenarioInternals = {
    finalize: (opts) => {
      const result = computeResult(entries, currentEntry, emitAugment, opts?.failure);
      return { entries, judgeUsages, result };
    },
    emitOutboundReceived,
    emitCliMock,
    getMockHandlers: () => mockHandlers,
    peekEntries: () => ({ entries }),
    isScenarioEnded: () => scenarioEnded,
  };

  function awaitOutboundEntry(messageId: string): Promise<OutboundReceivedEntry> {
    const existing = outboundByMessageId.get(messageId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      outboundWaiters.set(messageId, resolve);
    });
  }

  return { ctx, internals };
}

interface EmitDeps {
  emit: <T extends ReportEntry>(entry: T) => T;
  nextEntrySeqTs: () => { entrySeq: number; ts: string };
}

interface AttachDeps {
  getCurrentEntry: () => ActionEntry | undefined;
  emitAugment: (entrySeq: number, patch: AugmentPatch) => void;
}

function computeResult(
  entries: ReportEntry[],
  currentEntry: ActionEntry | undefined,
  emitAugment: (entrySeq: number, patch: AugmentPatch) => void,
  scenarioFailure: ScenarioFailure | undefined,
): ScenarioResult {
  if (scenarioFailure && currentEntry && !currentEntry.failure) {
    currentEntry.failure = scenarioFailure;
    emitAugment(currentEntry.entrySeq, { kind: "failure", failure: scenarioFailure });
  }

  const failedEntry = findFailedEntry(entries);
  if (failedEntry) {
    return {
      verdict: "fail",
      cause: "failedEntry",
      entrySeq: failedEntry.entrySeq,
      message: `[entry #${failedEntry.entrySeq}] ${failedEntry.failure?.message ?? ""}`,
    };
  }

  if (!scenarioFailure) return { verdict: "pass" };

  const result: ErrorScenarioResult = {
    verdict: "fail",
    cause: "error",
    source: scenarioFailure.source,
    errorName: scenarioFailure.name,
    message: scenarioFailure.message,
  };
  if (scenarioFailure.stack) result.stack = scenarioFailure.stack;
  return result;
}

function findFailedEntry(entries: ReportEntry[]): ActionEntry | undefined {
  for (const e of entries) {
    if (e.kind === "scenarioLog") continue;
    if (e.failure) return e;
  }
  return;
}

function pushAssertion(
  deps: Pick<AttachDeps, "emitAugment">,
  target: ActionEntry | undefined,
  record: AssertionRecord,
): void {
  if (!target) return;
  if (!target.assertions) target.assertions = [];
  target.assertions.push(record);
  deps.emitAugment(target.entrySeq, { kind: "assertion", assertion: record });
}

function registerMockCli(
  handlers: Map<string, CliMockHandler>,
  name: string,
  handler: CliMockHandler,
  opts: MockCliRegisterOptions | undefined,
): void {
  const mode: MockCliRegisterMode = opts?.mode ?? "register";
  const exists = handlers.has(name);
  if (mode === "register") {
    if (exists) throw new Error(`mockCli: handler for "${name}" already registered`);
    handlers.set(name, handler);
    return;
  }
  if (mode === "replace") {
    if (!exists) throw new Error(`mockCli: no handler for "${name}" to replace`);
    handlers.set(name, handler);
    return;
  }
  // "ifAbsent"
  if (!exists) handlers.set(name, handler);
}

async function sendInbound(
  deps: EmitDeps,
  accountId: ChannelId,
  conversationId: string,
  input: SendInboundInput,
): Promise<SendInboundResult> {
  const conversation: Conversation = input.conversation ?? {
    kind: "channel",
    id: conversationId,
    title: conversationId,
  };
  const r = await injectQaBusInboundMessage({
    baseUrl: BUS_URL,
    input: {
      accountId,
      conversation,
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      threadId: input.threadId,
    },
  });
  const entry: InboundSentEntry = {
    ...deps.nextEntrySeqTs(),
    kind: "inboundSent",
    messageId: r.message.id,
    text: input.text,
    senderId: input.senderId,
    ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  };
  deps.emit(entry);
  return { message: r.message, entry };
}

async function poll(
  accountId: ChannelId,
  opts: { sinceCursor: number; timeoutMs?: number },
): Promise<PollResult> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  // Client-side hard stop. The bus holds the long-poll for `timeoutMs` then answers, but a wedged
  // bus or a half-open connection would hang this `fetch` forever — and callers loop on their own
  // deadline (`waitForOutbound`), so a hung poll silently defeats that deadline and the runner never
  // exits (the intermittent post-verdict hang). Abort a bit past the server hold so a stall surfaces
  // as an empty poll and the caller's loop keeps ticking toward its real timeout.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
  let r: QaBusPollResult;
  try {
    r = await pollQaBus({
      baseUrl: BUS_URL,
      accountId,
      cursor: opts.sinceCursor,
      timeoutMs,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return { messages: [], nextCursor: opts.sinceCursor };
    throw err;
  } finally {
    clearTimeout(abortTimer);
  }
  const messages = r.events
    .filter((e) => e.kind === "outbound-message" || e.kind === "message-edited")
    .map((e) => (e as { message: BusMessage }).message);
  return { messages, nextCursor: r.cursor };
}

export interface WaitForOutboundDeps {
  accountId: ChannelId;
  awaitEntry: (id: string) => Promise<OutboundReceivedEntry>;
  getLastCliMock: () => { atMs: number; entry: CliMockEntry } | undefined;
}

export interface WaitForOutboundOpts {
  sinceCursor: number;
  timeoutMs?: number;
  failFastUnmatchedOutbounds?: number | false;
  failFastCliMockGraceMs?: number | false;
  pollImpl?: (
    accountId: ChannelId,
    opts: { sinceCursor: number; timeoutMs?: number },
  ) => Promise<PollResult>;
  nowImpl?: () => number;
}

export async function waitForOutbound(
  deps: WaitForOutboundDeps,
  predicate: (m: BusMessage) => boolean,
  opts: WaitForOutboundOpts,
): Promise<WaitForOutboundResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxUnmatched = opts.failFastUnmatchedOutbounds ?? 3;
  const cliMockGraceMs = opts.failFastCliMockGraceMs ?? 10_000;
  const pollFn = opts.pollImpl ?? poll;
  const now = opts.nowImpl ?? Date.now;
  const deadline = now() + timeoutMs;
  let cursor = opts.sinceCursor;
  let unmatched = 0;
  let lastUnmatched: BusMessage | undefined;

  while (now() < deadline) {
    const remaining = Math.max(0, deadline - now());
    const { messages, nextCursor } = await pollFn(deps.accountId, {
      sinceCursor: cursor,
      timeoutMs: Math.min(5000, remaining),
    });
    cursor = nextCursor;

    const match = messages.find(predicate);
    if (match) {
      const entry = await deps.awaitEntry(match.id);
      return { match, entry, nextCursor };
    }

    if (messages.length > 0) {
      unmatched += messages.length;
      lastUnmatched = messages[messages.length - 1];
      if (maxUnmatched !== false && unmatched >= maxUnmatched) {
        throw await unmatchedFastFailError(deps, unmatched, lastUnmatched);
      }
    }

    if (cliMockGraceMs !== false) {
      const last = deps.getLastCliMock();
      if (last && now() - last.atMs >= cliMockGraceMs) {
        throw cliMockGraceFastFailError(cliMockGraceMs, last.entry);
      }
    }
  }
  throw new AssertionError(`waitForOutbound timed out after ${timeoutMs}ms`);
}

function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

async function unmatchedFastFailError(
  deps: WaitForOutboundDeps,
  count: number,
  msg: BusMessage,
): Promise<AssertionError> {
  const entry = await raceTimeout(deps.awaitEntry(msg.id), 50);
  const seqOrId = entry ? `entrySeq=${entry.entrySeq}` : `msg=${msg.id}`;
  const thread = msg.threadId !== undefined ? `threadId=${msg.threadId}` : "no threadId";
  const text = truncate(msg.text);
  return new AssertionError(
    `waitForOutbound: agent posted ${count} outbounds but none matched the predicate\n` +
      `  observed: outbound ${seqOrId} (${thread}, text=${JSON.stringify(text)})`,
  );
}

function cliMockGraceFastFailError(graceMs: number, entry: CliMockEntry): AssertionError {
  const cli = entry.call.cli;
  const argvHead = truncate(entry.call.argv.join(" "));
  return new AssertionError(
    `waitForOutbound: agent invoked a mocked CLI and did not produce a matching outbound within ${graceMs}ms\n` +
      `  observed: cliMock ${cli} (argv head: ${JSON.stringify(argvHead)}), no outbound followed`,
  );
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race<T | undefined>([
    p,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

async function expectNoOutbound(
  accountId: ChannelId,
  predicate: (m: BusMessage) => boolean,
  opts: { withinMs: number; sinceCursor: number },
): Promise<{ nextCursor: number }> {
  const deadline = Date.now() + opts.withinMs;
  let cursor = opts.sinceCursor;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const { messages, nextCursor } = await poll(accountId, {
      sinceCursor: cursor,
      timeoutMs: Math.min(remaining, 1000),
    });
    cursor = nextCursor;
    const offender = messages.find(predicate);
    if (offender) {
      throw new AssertionError(
        `expectNoOutbound: forbidden message arrived: ${JSON.stringify({
          id: offender.id,
          text: offender.text,
          threadId: offender.threadId,
        })}`,
      );
    }
  }
  return { nextCursor: cursor };
}

interface WaitForToolCallDeps extends AttachDeps {
  conversationId: string;
  startedAtIso: string;
}

async function waitForAgentToolCall(
  deps: WaitForToolCallDeps,
  predicate: (call: AgentToolCall) => boolean,
  opts: WaitForAgentToolCallOptions,
): Promise<AgentToolCall> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let calls: AgentToolCall[] = [];
  while (Date.now() < deadline) {
    calls = parseAgentToolCalls({
      conversationId: deps.conversationId,
      startedAtIso: deps.startedAtIso,
    });
    const match = calls.find(predicate);
    if (match) {
      pushAssertion(deps, deps.getCurrentEntry(), { label: opts.label, ok: true });
      return match;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const detail = `no agent tool call matched within ${timeoutMs}ms; observed: ${summarizeToolCalls(calls)}`;
  pushAssertion(deps, deps.getCurrentEntry(), { label: opts.label, ok: false, detail });
  throw new AssertionError(`${opts.label}: ${detail}`);
}

function summarizeToolCalls(calls: AgentToolCall[]): string {
  if (calls.length === 0) return "(none)";
  return calls.map((c) => `${c.toolName}${toolCallHint(c.input)}`).join("; ");
}

function toolCallHint(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input.path === "string") return ` ${input.path}`;
  if (typeof input.command === "string") return ` ${input.command.slice(0, 60)}`;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertRegex(deps: AttachDeps, actual: string, pattern: RegExp, label: string): void {
  failingAssert(
    deps,
    pattern.test(actual),
    label,
    `value=${JSON.stringify(actual)} pattern=${pattern.source}`,
  );
}

function assertEqual<T>(deps: AttachDeps, actual: T, expected: T, label: string): void {
  failingAssert(
    deps,
    actual === expected,
    label,
    `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

function assertLength(
  deps: AttachDeps,
  value: { length: number } | string | unknown[],
  expected: number,
  label: string,
): void {
  failingAssert(
    deps,
    value.length === expected,
    label,
    `expected length=${expected} actual=${value.length}`,
  );
}

function failingAssert(deps: AttachDeps, ok: boolean, label: string, detail: string): void {
  if (ok) return;
  pushAssertion(deps, deps.getCurrentEntry(), { label, ok: false, detail });
  throw new AssertionError(`${label}: ${detail}`);
}

async function callJudgeVerdict(
  deps: Pick<AttachDeps, "emitAugment"> & { judgeUsages: JudgeUsage[] },
  p: {
    attachTo: ActionEntry;
    message: string;
    rubric: string;
    label: string;
    maxTokens?: number;
  },
): Promise<JudgeVerdict> {
  const verdict = await judgeLLM({
    message: p.message,
    rubric: p.rubric,
    maxTokens: p.maxTokens,
  });
  deps.judgeUsages.push(verdict.usage);
  const extra = {
    judge: {
      model: verdict.usage.model,
      usage: {
        inputTokens: verdict.usage.inputTokens,
        outputTokens: verdict.usage.outputTokens,
      },
      costUsd: judgeCostUsd(verdict.usage),
    },
  };
  if (verdict.verdict === "pass") {
    pushAssertion(deps, p.attachTo, { label: p.label, ok: true, extra });
    return verdict;
  }
  pushAssertion(deps, p.attachTo, { label: p.label, ok: false, detail: verdict.reasoning, extra });
  throw new AssertionError(`${p.label}: ${verdict.reasoning}`);
}

async function callJudgeJson<T>(
  judgeUsages: JudgeUsage[],
  p: { message: string; prompt: string; returnType: string; label: string; maxTokens?: number },
): Promise<JudgeVerdictJson<T>> {
  const result = await judgeLLMJson<T>({
    message: p.message,
    prompt: p.prompt,
    returnType: p.returnType,
    maxTokens: p.maxTokens,
  });
  judgeUsages.push(result.usage);
  return result;
}

async function callJudgeRaw(
  judgeUsages: JudgeUsage[],
  p: { prompt: string; label: string; maxTokens?: number },
): Promise<JudgeVerdictRaw> {
  const result = await judgeLLMRaw(p.prompt, { maxTokens: p.maxTokens });
  judgeUsages.push(result.usage);
  return result;
}

async function getCursor(): Promise<number> {
  const snap = await getQaBusState(BUS_URL);
  return snap.cursor;
}

const IPC_DIR = "/var/run/openclaw-test-ipc";
// Wait this much longer than the requested timeout before declaring the
// host-side poll dead. Gives the watcher time to kill the child on its own
// timeout (exitCode 124) and write the truncated response file.
const WATCHER_DEADLINE_HEADROOM_MS = 5_000;
const EXEC_POLL_INTERVAL_MS = 100;
const WATCHER_TIMEOUT_EXIT_CODE = 124;

async function execInGateway(
  argv: string[],
  opts: ExecInGatewayOptions = {},
): Promise<ExecInGatewayResult> {
  const id = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const payload: Record<string, unknown> = { id, argv, timeoutMs };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  if (opts.env !== undefined) payload.env = opts.env;
  if (opts.stdin !== undefined) payload.stdin = opts.stdin;
  const reqPath = `${IPC_DIR}/${id}.req.json`;
  const reqTmp = `${reqPath}.tmp`;
  const resPath = `${IPC_DIR}/${id}.res.json`;
  writeFileSync(reqTmp, JSON.stringify(payload));
  renameSync(reqTmp, reqPath);
  const deadline = Date.now() + timeoutMs + WATCHER_DEADLINE_HEADROOM_MS;
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      const raw = readFileSync(resPath, "utf8");
      rmSync(resPath, { force: true });
      rmSync(reqPath, { force: true });
      const parsed = JSON.parse(raw) as ExecInGatewayResult;
      if (parsed.exitCode === WATCHER_TIMEOUT_EXIT_CODE) {
        console.warn(
          `execInGateway: watcher killed child after ${timeoutMs}ms (id ${id}, argv ${JSON.stringify(argv)})`,
        );
      }
      return parsed;
    }
    await new Promise((r) => setTimeout(r, EXEC_POLL_INTERVAL_MS));
  }
  rmSync(reqPath, { force: true });
  throw new Error(`execInGateway timed out waiting for response (request id ${id})`);
}
