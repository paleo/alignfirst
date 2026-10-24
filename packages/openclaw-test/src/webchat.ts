import { randomUUID } from "node:crypto";
import { AssertionError } from "./assertion-error.js";
import type { ExecInGatewayOptions, ExecInGatewayResult } from "./exec-rpc.js";
import type {
  ActionEntry,
  InboundSentEntry,
  OutboundReceivedEntry,
  ReportEntry,
} from "./report.js";

export const WEBCHAT_SURFACE = "webchat";
const HOME_KEY = "agent:main:main";
const OPERATOR_SENDER_ID = "operator";
const GATEWAY_CALL_TIMEOUT_MS = 60_000;
const HISTORY_POLL_MS = 2_000;
const HISTORY_LIMIT = 200;
const HISTORY_TOOL_RESULT_MAX_CHARS = 200;
const DEFAULT_REPLY_TIMEOUT_MS = 30_000;

/**
 * Drives OpenClaw app conversations through the gateway methods the apps use, run inside the
 * gateway container with `openclaw gateway call`.
 */
export interface WebchatDriver {
  /** Home: `agent:main:main`, reset at the start of the cell before its first use. */
  readonly homeKey: string;
  /** `sessions.create` without an initial message, so the result carries the worktree. */
  createConversation(input?: CreateConversationInput): Promise<CreatedConversation>;
  /** `chat.send`; records an `inboundSent` entry. Replies already in the history no longer count. */
  send(sessionKey: string, text: string): Promise<InboundSentEntry>;
  /**
   * Polls `chat.history` until a new assistant reply matches; records each new reply as an
   * `outboundReceived` entry, so judges and reports work unchanged. A match is consumed with
   * the replies before it.
   */
  waitForReply(
    sessionKey: string,
    predicate: (reply: WebchatReply) => boolean,
    opts?: WaitForReplyOptions,
  ): Promise<WebchatReply>;
  /** Fails when an assistant reply arrives within the window. */
  expectNoReply(sessionKey: string, opts: { withinMs: number }): Promise<void>;
}

export interface CreateConversationInput {
  label?: string;
  /** Absolute gateway path: a project folder. */
  cwd?: string;
  /** With `cwd`: an OpenClaw managed worktree, branch `openclaw/<name>`. */
  worktree?: { name: string };
}

export interface CreatedConversation {
  sessionKey: string;
  /** The managed worktree the create result reports: its path and `openclaw/<name>` branch. */
  worktree?: { path: string; branch: string };
}

export interface WebchatReply {
  /** The text blocks of the assistant message, joined with newlines. */
  text: string;
  timestamp: number;
  entry: OutboundReceivedEntry;
}

export interface WaitForReplyOptions {
  /** Default 30_000. */
  timeoutMs?: number;
}

export interface WebchatDriverDeps {
  execInGateway(argv: string[], opts?: ExecInGatewayOptions): Promise<ExecInGatewayResult>;
  emit<T extends ReportEntry>(entry: T): T;
  nextEntrySeqTs(): { entrySeq: number; ts: string };
  setCurrentEntry<T extends ActionEntry>(entry: T): T;
  /** Every session key the driver touched; the runner captures their transcripts. */
  sessionKeys: Set<string>;
}

interface DriverState {
  deps: WebchatDriverDeps;
  /** Per session key: the history `seq` up to which replies no longer count. */
  cursors: Map<string, number>;
  /** Per session key: the replies already recorded as entries, by history `seq`. */
  recorded: Map<string, Map<number, WebchatReply>>;
  homeReset?: Promise<void>;
}

interface HistoryReply {
  seq: number;
  id: string | undefined;
  text: string;
  timestamp: number;
}

export function createWebchatDriver(deps: WebchatDriverDeps): WebchatDriver {
  const state: DriverState = { deps, cursors: new Map(), recorded: new Map() };
  return {
    homeKey: HOME_KEY,
    createConversation: (input) => createConversation(state, input),
    send: (sessionKey, text) => send(state, sessionKey, text),
    waitForReply: (sessionKey, predicate, opts) => waitForReply(state, sessionKey, predicate, opts),
    expectNoReply: (sessionKey, opts) => expectNoReply(state, sessionKey, opts),
  };
}

async function createConversation(
  state: DriverState,
  input: CreateConversationInput = {},
): Promise<CreatedConversation> {
  const params: Record<string, unknown> = {};
  if (input.label !== undefined) params.label = input.label;
  if (input.cwd !== undefined) params.cwd = input.cwd;
  if (input.worktree) {
    params.worktree = true;
    params.worktreeName = input.worktree.name;
  }
  const response = await gatewayCall(state.deps, "sessions.create", params);
  if (!isRecord(response) || typeof response.key !== "string") {
    throw new Error(
      `sessions.create returned no session key: ${truncate(JSON.stringify(response))}`,
    );
  }
  const sessionKey = response.key;
  state.deps.sessionKeys.add(sessionKey);
  const worktree = readCreatedWorktree(response);
  return worktree ? { sessionKey, worktree } : { sessionKey };
}

async function gatewayCall(
  deps: WebchatDriverDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await deps.execInGateway(
    ["openclaw", "gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    { timeoutMs: GATEWAY_CALL_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `gateway call ${method} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`gateway call ${method} printed no JSON: ${truncate(result.stdout)}`);
  }
}

function readCreatedWorktree(
  response: Record<string, unknown>,
): { path: string; branch: string } | undefined {
  const worktree = response.worktree;
  if (!isRecord(worktree)) return;
  const { path, branch } = worktree;
  if (typeof path !== "string" || typeof branch !== "string") return;
  return { path, branch };
}

async function send(
  state: DriverState,
  sessionKey: string,
  text: string,
): Promise<InboundSentEntry> {
  const { deps } = state;
  await prepareSession(state, sessionKey);
  state.cursors.set(sessionKey, latestSeq(await readHistory(state, sessionKey)));
  const idempotencyKey = randomUUID();
  const response = await gatewayCall(deps, "chat.send", {
    sessionKey,
    message: text,
    idempotencyKey,
  });
  const runId = isRecord(response) ? response.runId : undefined;
  return deps.emit<InboundSentEntry>({
    ...deps.nextEntrySeqTs(),
    kind: "inboundSent",
    messageId: typeof runId === "string" ? runId : idempotencyKey,
    text,
    senderId: OPERATOR_SENDER_ID,
  });
}

/** Home keeps earlier cells' history under `--reuse-stack`; reset it once, before its first send. */
async function prepareSession(state: DriverState, sessionKey: string): Promise<void> {
  if (sessionKey === HOME_KEY) {
    state.homeReset ??= gatewayCall(state.deps, "sessions.reset", { key: HOME_KEY }).then(() => {});
    await state.homeReset;
  }
  state.deps.sessionKeys.add(sessionKey);
}

async function readHistory(state: DriverState, sessionKey: string): Promise<unknown[]> {
  const response = await gatewayCall(state.deps, "chat.history", {
    sessionKey,
    limit: HISTORY_LIMIT,
    toolResultMaxChars: HISTORY_TOOL_RESULT_MAX_CHARS,
  });
  const messages = isRecord(response) ? response.messages : undefined;
  if (!Array.isArray(messages)) {
    throw new Error(`chat.history returned no messages for ${sessionKey}`);
  }
  return messages;
}

function latestSeq(messages: unknown[]): number {
  let latest = 0;
  for (const message of messages) {
    const seq = readSeq(message);
    if (seq !== undefined && seq > latest) latest = seq;
  }
  return latest;
}

function readSeq(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.__openclaw)) return;
  const seq = message.__openclaw.seq;
  return typeof seq === "number" ? seq : undefined;
}

async function waitForReply(
  state: DriverState,
  sessionKey: string,
  predicate: (reply: WebchatReply) => boolean,
  opts: WaitForReplyOptions = {},
): Promise<WebchatReply> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  state.deps.sessionKeys.add(sessionKey);
  for (;;) {
    const replies = await readNewReplies(state, sessionKey);
    for (const reply of replies) {
      const recorded = recordReply(state, sessionKey, reply);
      if (!predicate(recorded)) continue;
      state.cursors.set(sessionKey, reply.seq);
      state.deps.setCurrentEntry(recorded.entry);
      return recorded;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw replyTimeoutError(sessionKey, timeoutMs, replies);
    await sleep(Math.min(HISTORY_POLL_MS, remaining));
  }
}

async function readNewReplies(state: DriverState, sessionKey: string): Promise<HistoryReply[]> {
  const cursor = state.cursors.get(sessionKey) ?? 0;
  const messages = await readHistory(state, sessionKey);
  const replies: HistoryReply[] = [];
  for (const message of messages) {
    const reply = readReply(message);
    if (reply && reply.seq > cursor) replies.push(reply);
  }
  return replies;
}

/**
 * A reply is a turn-final assistant message with text. Tool-use steps, the `Reset` system
 * message and user messages are skipped; the gateway already hides silent replies.
 */
function readReply(message: unknown): HistoryReply | undefined {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "stop") return;
  const text = readText(message.content);
  if (text.length === 0) return;
  const seq = readSeq(message);
  if (seq === undefined) throw new Error("chat.history: assistant message without __openclaw.seq");
  const meta = message.__openclaw;
  const id = isRecord(meta) && typeof meta.id === "string" ? meta.id : undefined;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
  return { seq, id, text, timestamp };
}

function readText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/** Records a reply as an `outboundReceived` entry the first time it is seen. */
function recordReply(state: DriverState, sessionKey: string, reply: HistoryReply): WebchatReply {
  const { deps } = state;
  let bySeq = state.recorded.get(sessionKey);
  if (!bySeq) {
    bySeq = new Map();
    state.recorded.set(sessionKey, bySeq);
  }
  const known = bySeq.get(reply.seq);
  if (known) return known;
  const entry = deps.emit<OutboundReceivedEntry>({
    ...deps.nextEntrySeqTs(),
    kind: "outboundReceived",
    messageId: reply.id ?? `${sessionKey}#${reply.seq}`,
    text: reply.text,
  });
  deps.setCurrentEntry(entry);
  const recorded: WebchatReply = { text: reply.text, timestamp: reply.timestamp, entry };
  bySeq.set(reply.seq, recorded);
  return recorded;
}

function replyTimeoutError(
  sessionKey: string,
  timeoutMs: number,
  unmatched: HistoryReply[],
): AssertionError {
  const observed =
    unmatched.length === 0
      ? "(none)"
      : unmatched.map((reply) => JSON.stringify(truncate(reply.text))).join("; ");
  return new AssertionError(
    `waitForReply: no reply in ${sessionKey} matched within ${timeoutMs}ms; unmatched replies: ${observed}`,
  );
}

async function expectNoReply(
  state: DriverState,
  sessionKey: string,
  opts: { withinMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.withinMs;
  state.deps.sessionKeys.add(sessionKey);
  for (;;) {
    const [offender] = await readNewReplies(state, sessionKey);
    if (offender) {
      recordReply(state, sessionKey, offender);
      throw new AssertionError(
        `expectNoReply: a reply arrived in ${sessionKey}: ${JSON.stringify(truncate(offender.text))}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(HISTORY_POLL_MS, remaining));
  }
}

/** The `ctx.webchat` of a channel cell: every call throws. */
export function createUnavailableWebchatDriver(): WebchatDriver {
  const unavailable = (): never => {
    throw new Error("ctx.webchat is available on the webchat surface only");
  };
  return {
    homeKey: HOME_KEY,
    createConversation: unavailable,
    send: unavailable,
    waitForReply: unavailable,
    expectNoReply: unavailable,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
