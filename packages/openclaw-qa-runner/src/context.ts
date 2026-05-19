import { judgeLLM, type JudgeUsage, type JudgeVerdict } from "./judge.js";

const BUS_URL = process.env.QA_BUS_URL ?? "http://bus:43123";

export type ChannelId = "discord-mock" | "slack-mock";

export type Conversation = { kind: "direct" | "group" | "channel"; id: string; title?: string };

export type BusMessage = {
  id: string;
  accountId: string;
  direction: "inbound" | "outbound";
  conversation: Conversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
};

type BusEvent = { cursor: number; kind: string; accountId: string; message?: BusMessage };

export type PollResult = { messages: BusMessage[]; nextCursor: number };

export type AssertionRecord =
  | { label: string; ok: true }
  | { label: string; ok: false; detail: string };
export type JudgeCallRecord = { label: string; verdict: "pass" | "fail"; reasoning: string };

export class AssertionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AssertionError";
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${BUS_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST ${path} -> ${resp.status}: ${text}`);
  }
  return (await resp.json()) as T;
}

export type ScenarioContext = ReturnType<typeof createContext>;

export function createContext(params: { channel: ChannelId; conversationId: string }) {
  const channel = params.channel;
  const conversationId = params.conversationId;
  const accountId = channel;
  const logLines: string[] = [];
  const assertions: AssertionRecord[] = [];
  const judgeCalls: JudgeCallRecord[] = [];
  const judgeUsages: JudgeUsage[] = [];

  function log(message: string) {
    const stamp = new Date().toISOString();
    logLines.push(`- [${stamp}] ${message}`);
  }

  async function sendInbound(input: {
    senderId: string;
    senderName?: string;
    text: string;
    threadId?: string;
    conversation?: Conversation;
  }): Promise<BusMessage> {
    const conversation: Conversation = input.conversation ?? {
      kind: "channel",
      id: conversationId,
      title: conversationId,
    };
    const payload = {
      accountId,
      conversation,
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      threadId: input.threadId,
    };
    const r = await postJson<{ message: BusMessage }>("/v1/inbound/message", payload);
    log(`inbound sent: ${JSON.stringify({ id: r.message.id, text: input.text })}`);
    return r.message;
  }

  async function poll(opts: { sinceCursor: number; timeoutMs?: number }): Promise<PollResult> {
    const r = await postJson<{ cursor: number; events: BusEvent[] }>("/v1/poll", {
      cursor: opts.sinceCursor,
      timeoutMs: opts.timeoutMs ?? 1000,
      accountId,
    });
    const messages = r.events
      .filter((e) => (e.kind === "outbound-message" || e.kind === "message-edited") && e.message)
      .map((e) => e.message as BusMessage);
    return { messages, nextCursor: r.cursor };
  }

  async function waitForOutbound(
    predicate: (m: BusMessage) => boolean,
    opts: { timeoutMs?: number; sinceCursor: number },
  ): Promise<{ match: BusMessage; nextCursor: number }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let cursor = opts.sinceCursor;
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const { messages, nextCursor } = await poll({
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
    predicate: (m: BusMessage) => boolean,
    opts: { withinMs: number; sinceCursor: number },
  ): Promise<{ nextCursor: number }> {
    const deadline = Date.now() + opts.withinMs;
    let cursor = opts.sinceCursor;
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const { messages, nextCursor } = await poll({
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

  function recordAssertion(ok: boolean, label: string, detail?: string) {
    if (ok) {
      assertions.push({ label, ok: true });
      log(`assert OK: ${label}`);
    } else {
      assertions.push({ label, ok: false, detail: detail ?? "" });
      throw new AssertionError(`${label}: ${detail ?? ""}`);
    }
  }

  function assertRegex(actual: string, pattern: RegExp, label: string) {
    recordAssertion(
      pattern.test(actual),
      label,
      `value=${JSON.stringify(actual)} pattern=${pattern.source}`,
    );
  }

  function assertEqual<T>(actual: T, expected: T, label: string) {
    recordAssertion(
      actual === expected,
      label,
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }

  function assertLength(
    value: { length: number } | string | unknown[],
    expected: number,
    label: string,
  ) {
    const len = (value as { length: number }).length;
    recordAssertion(len === expected, label, `expected length=${expected} actual=${len}`);
  }

  async function callJudge(p: {
    message: string;
    rubric: string;
    label: string;
  }): Promise<JudgeVerdict> {
    const verdict = await judgeLLM({ message: p.message, rubric: p.rubric });
    judgeCalls.push({ label: p.label, verdict: verdict.verdict, reasoning: verdict.reasoning });
    judgeUsages.push(verdict.usage);
    log(`judge[${p.label}] = ${verdict.verdict} — ${verdict.reasoning}`);
    if (verdict.verdict !== "pass") {
      throw new AssertionError(`judge[${p.label}] failed: ${verdict.reasoning}`);
    }
    return verdict;
  }

  async function getCursor(): Promise<number> {
    const r = await fetch(`${BUS_URL}/v1/state`);
    const snap = (await r.json()) as { cursor: number };
    return snap.cursor;
  }

  return {
    channel,
    conversationId,
    accountId,
    log,
    sendInbound,
    poll,
    waitForOutbound,
    expectNoOutbound,
    assertRegex,
    assertEqual,
    assertLength,
    judgeLLM: callJudge,
    getCursor,
    _drain: () => ({ logLines, assertions, judgeCalls, judgeUsages }),
  };
}
