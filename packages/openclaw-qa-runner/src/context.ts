import {
  getQaBusState,
  injectQaBusInboundMessage,
  pollQaBus,
  type QaBusConversation,
  type QaBusMessage,
  type QaBusPollResult,
} from "@paleo/openclaw-channel-mock-core";
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
  AssertionRecord,
  ChannelId,
  CliMockCall,
  CliMockHandler,
  EmitSink,
  ReportEvent,
  ScenarioFailure,
} from "./report.js";

const BUS_URL = process.env.QA_BUS_URL ?? "http://bus:43123";

export type { ChannelId } from "./report.js";
export type Conversation = QaBusConversation;
export type BusMessage = QaBusMessage;

export interface PollResult {
  messages: BusMessage[];
  nextCursor: number;
}

export interface ScenarioContext {
  channel: ChannelId;
  conversationId: string;
  accountId: ChannelId;
  log(message: string): void;
  sendInbound(input: SendInboundInput): Promise<BusMessage>;
  poll(opts: { sinceCursor: number; timeoutMs?: number }): Promise<PollResult>;
  waitForOutbound(
    predicate: (m: BusMessage) => boolean,
    opts: { timeoutMs?: number; sinceCursor: number },
  ): Promise<{ match: BusMessage; nextCursor: number }>;
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
  judgeLLM(p: {
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
  mockCli(name: string, handler: CliMockHandler): void;
}

export interface ScenarioInternals {
  finalize(opts?: { failure?: ScenarioFailure }): {
    events: ReportEvent[];
    judgeUsages: JudgeUsage[];
  };
  emitOutboundReceived(m: BusMessage): void;
  emitCliMock(call: CliMockCall): void;
  getMockHandlers(): Map<string, CliMockHandler>;
  peekEvents(): { events: ReportEvent[] };
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
  emitSink?: EmitSink;
}): { ctx: ScenarioContext; internals: ScenarioInternals } {
  const { channel, conversationId, emitSink } = params;
  const accountId: ChannelId = channel;
  const events: ReportEvent[] = [];
  const judgeUsages: JudgeUsage[] = [];
  const mockHandlers = new Map<string, CliMockHandler>();
  let seq = 0;

  const emit = (partial: EmitInput): ReportEvent => {
    const sealed = { seq: seq++, ts: new Date().toISOString(), ...partial } as ReportEvent;
    events.push(sealed);
    if (emitSink) emitSink(sealed);
    return sealed;
  };

  const ctx: ScenarioContext = {
    channel,
    conversationId,
    accountId,
    log: (message) => void emit({ kind: "log", message }),
    sendInbound: (input) => sendInbound(emit, accountId, conversationId, input),
    poll: (opts) => poll(accountId, opts),
    waitForOutbound: (predicate, opts) => waitForOutbound(accountId, predicate, opts),
    expectNoOutbound: (predicate, opts) => expectNoOutbound(accountId, predicate, opts),
    assertRegex: (actual, pattern, label) => assertRegex(emit, actual, pattern, label),
    assertEqual: (actual, expected, label) => assertEqual(emit, actual, expected, label),
    assertLength: (value, expected, label) => assertLength(emit, value, expected, label),
    judgeLLM: (p) => callJudgeVerdict(emit, judgeUsages, p),
    judgeLLMJson: (p) => callJudgeJson(judgeUsages, p),
    judgeLLMRaw: (p) => callJudgeRaw(judgeUsages, p),
    getCursor,
    mockCli: (name, handler) => registerMockCli(mockHandlers, name, handler),
  };

  const internals: ScenarioInternals = {
    finalize: (opts) => {
      if (opts?.failure) emit({ kind: "failure", failure: opts.failure });
      return { events, judgeUsages };
    },
    emitOutboundReceived: (m) =>
      void emit({ kind: "outboundReceived", messageId: m.id, text: m.text, threadId: m.threadId }),
    emitCliMock: (call) => void emit({ kind: "cliMock", call }),
    getMockHandlers: () => mockHandlers,
    peekEvents: () => ({ events }),
  };

  return { ctx, internals };
}

type EmitInput = DistributedOmit<ReportEvent, "seq" | "ts">;
type DistributedOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type EmitFn = (partial: EmitInput) => ReportEvent;

function registerMockCli(
  handlers: Map<string, CliMockHandler>,
  name: string,
  handler: CliMockHandler,
): void {
  if (handlers.has(name)) {
    throw new Error(`mockCli: handler for "${name}" already registered`);
  }
  handlers.set(name, handler);
}

async function sendInbound(
  emit: EmitFn,
  accountId: ChannelId,
  conversationId: string,
  input: SendInboundInput,
): Promise<BusMessage> {
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
  emit({
    kind: "inboundSent",
    messageId: r.message.id,
    text: input.text,
    senderId: input.senderId,
    senderName: input.senderName,
    threadId: input.threadId,
  });
  return r.message;
}

async function poll(
  accountId: ChannelId,
  opts: { sinceCursor: number; timeoutMs?: number },
): Promise<PollResult> {
  const r: QaBusPollResult = await pollQaBus({
    baseUrl: BUS_URL,
    accountId,
    cursor: opts.sinceCursor,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  const messages = r.events
    .filter((e) => e.kind === "outbound-message" || e.kind === "message-edited")
    .map((e) => (e as { message: BusMessage }).message);
  return { messages, nextCursor: r.cursor };
}

async function waitForOutbound(
  accountId: ChannelId,
  predicate: (m: BusMessage) => boolean,
  opts: { timeoutMs?: number; sinceCursor: number },
): Promise<{ match: BusMessage; nextCursor: number }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let cursor = opts.sinceCursor;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const { messages, nextCursor } = await poll(accountId, {
      sinceCursor: cursor,
      timeoutMs: Math.min(5000, remaining),
    });
    cursor = nextCursor;
    const match = messages.find(predicate);
    if (match) return { match, nextCursor };
  }
  throw new AssertionError(`waitForOutbound timed out after ${timeoutMs}ms`);
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

function assertRegex(emit: EmitFn, actual: string, pattern: RegExp, label: string): void {
  recordAssertion(
    emit,
    pattern.test(actual),
    label,
    `value=${JSON.stringify(actual)} pattern=${pattern.source}`,
  );
}

function assertEqual<T>(emit: EmitFn, actual: T, expected: T, label: string): void {
  recordAssertion(
    emit,
    actual === expected,
    label,
    `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

function assertLength(
  emit: EmitFn,
  value: { length: number } | string | unknown[],
  expected: number,
  label: string,
): void {
  const len = value.length;
  recordAssertion(emit, len === expected, label, `expected length=${expected} actual=${len}`);
}

function recordAssertion(emit: EmitFn, ok: boolean, label: string, detail: string): void {
  if (ok) {
    emit({ kind: "assertion", record: { label, ok: true } });
    return;
  }
  const record: AssertionRecord = { label, ok: false, detail };
  emit({ kind: "assertion", record });
  throw new AssertionError(`${label}: ${detail}`);
}

async function callJudgeVerdict(
  emit: EmitFn,
  judgeUsages: JudgeUsage[],
  p: { message: string; rubric: string; label: string; maxTokens?: number },
): Promise<JudgeVerdict> {
  const verdict = await judgeLLM({
    message: p.message,
    rubric: p.rubric,
    maxTokens: p.maxTokens,
  });
  judgeUsages.push(verdict.usage);
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
    emit({ kind: "assertion", record: { label: p.label, ok: true, extra } });
    return verdict;
  }
  emit({
    kind: "assertion",
    record: { label: p.label, ok: false, detail: verdict.reasoning, extra },
  });
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
