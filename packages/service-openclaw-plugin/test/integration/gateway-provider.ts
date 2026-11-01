import { createHash, randomUUID } from "node:crypto";
import type { createBus } from "@alignfirst/openclaw-channel-mock-core";

export const TAKEOVER_MESSAGE = "Take over this thread.";
export const FINALIZER_ANSWER = "ISOLATED_FINALIZER_ANSWER";
export const STARTER = "Project: Project-X\nTask: preserve this exact starter.";
export const MARKER = "TARGET_SESSION_STARTED";
export const RACING_HUMAN = "RACING_HUMAN_REPLY";
export const RACING_HUMAN_HANDLED = "RACING_HUMAN_HANDLED";
export const HUMAN_DURING_SEED = "HUMAN_DURING_SEED_REPLY";
export const HUMAN_DURING_SEED_HANDLED = "HUMAN_DURING_SEED_HANDLED";
const SILENT_TOKEN = "HEARTBEAT_OK";
const RESTART_RECOVERY_PROMPT = "Your previous turn was interrupted";

type Surface = "slack" | "discord";
type Snapshot = ReturnType<ReturnType<typeof createBus>["state"]["getSnapshot"]>;

export interface FixtureOptions {
  answerFinalizer?: boolean;
  nativeExecCompletion?: boolean;
  dropCompletionRoute?: boolean;
  claimTwice?: boolean;
  duplicateStart?: boolean;
  starterInThreadCreate?: boolean;
  holdFirstSeed?: boolean;
  silenceAfterClaim?: boolean;
  seedGate?: ProviderGate;
  siblingGate?: ProviderGate;
}

export interface ProviderGate {
  entered: boolean;
  released: boolean;
  hold(): Promise<void>;
  release(): void;
}

export interface ProviderReply {
  id: string;
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  gate?: ProviderGate;
}

export interface ProviderScript {
  reply(body: Record<string, unknown>): ProviderReply;
  restart(): void;
}

interface ScriptState {
  instance: string;
  sequence: number;
  flows: Map<string, Flow>;
  historicalCalls: Set<string>;
}

interface Flow {
  issued: Map<string, IssuedCall>;
  repeatedStart: boolean;
  repeatedClaim: boolean;
}

interface IssuedCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface Turn {
  id: string;
  surface: Surface;
  options: FixtureOptions;
  flow: Flow;
  user: string;
  snapshot: Snapshot;
  conversationId: string;
  issued?: IssuedCall;
  resultText?: string;
  status?: unknown;
}

interface Message {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export function createProviderScript(
  surface: Surface,
  bus: ReturnType<typeof createBus>,
  options: FixtureOptions,
): ProviderScript {
  const state: ScriptState = {
    instance: randomUUID().replaceAll("-", "").slice(0, 24),
    sequence: 0,
    flows: new Map(),
    historicalCalls: new Set(),
  };
  return {
    restart() {
      // Interrupted transcript calls are history, never permission for a new run's effect.
      for (const flow of state.flows.values()) {
        for (const id of flow.issued.keys()) state.historicalCalls.add(id);
      }
      state.flows.clear();
    },
    reply(body) {
      if (body.model !== "handoff-script" || !Array.isArray(body.messages)) {
        throw new Error("Unexpected scripted provider model/messages");
      }
      // Keep IDs alphanumeric and within OpenClaw's 40-character wire limit.
      const id = `${state.instance}${++state.sequence}`;
      if (!Array.isArray(body.tools)) {
        if (options.answerFinalizer) return { id, content: FINALIZER_ANSWER };
        throw new Error("Unexpected isolated finalizer request");
      }
      // The local OpenAI wire messages are checked through their call/result identities below.
      const messages = body.messages as Message[];
      return replyToTurn({
        id,
        surface,
        options,
        snapshot: bus.state.getSnapshot(),
        ...readCurrentFlow(messages, state),
      });
    },
  };
}

function readCurrentFlow(wireMessages: Message[], state: ScriptState) {
  // Runtime context moves to the wire tail after each tool result; it is not a new turn.
  const messages = wireMessages.filter(
    (message) => message.role !== "user" || !isRuntimeContext(message),
  );
  const boundary = messages.findLastIndex((message) => message.role === "user");
  if (boundary < 0) throw new Error("Provider request has no current user prompt");
  const prefix = JSON.stringify(messages.slice(0, boundary + 1));
  const key = createHash("sha256").update(prefix).digest("hex");
  let flow = state.flows.get(key);
  if (!flow) {
    flow = { issued: new Map(), repeatedStart: false, repeatedClaim: false };
    state.flows.set(key, flow);
  }
  const current = messages.slice(boundary + 1);
  const results = currentResults(current, flow, state.historicalCalls);
  const latest = results.at(-1);
  const issued =
    latest?.tool_call_id === undefined ? undefined : flow.issued.get(latest.tool_call_id);
  const resultText = latest === undefined ? undefined : text(latest.content);
  return {
    flow,
    user: text(messages[boundary].content),
    prefix: JSON.stringify(wireMessages),
    issued,
    resultText,
    status: resultText === undefined ? undefined : readStatus(resultText),
  };
}

function isRuntimeContext(message: Message): boolean {
  return (
    typeof message.content === "string" &&
    message.content.startsWith("OpenClaw runtime context:\n") &&
    message.content.endsWith("End OpenClaw runtime context.")
  );
}

function currentResults(messages: Message[], flow: Flow, historicalCalls: Set<string>): Message[] {
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const results = messages.filter(
    (message) => message.role === "tool" && !historicalCalls.has(message.tool_call_id ?? ""),
  );
  for (const result of results) {
    const issued =
      result.tool_call_id === undefined ? undefined : flow.issued.get(result.tool_call_id);
    const call = calls.find((candidate) => candidate.id === result.tool_call_id);
    if (
      !issued ||
      !call ||
      call.function.name !== issued.name ||
      JSON.stringify(JSON.parse(call.function.arguments)) !== JSON.stringify(issued.arguments)
    )
      throw new Error("Tool result does not belong to this flow's issued call");
  }
  return results;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  const serialized = JSON.stringify(content);
  if (serialized === undefined) throw new Error("Provider message has no content");
  return serialized;
}

function readStatus(content: string): unknown {
  try {
    return JSON.parse(content).status;
  } catch {
    return;
  }
}

function replyToTurn(input: Omit<Turn, "conversationId"> & { prefix: string }): ProviderReply {
  const turn: Turn = {
    ...input,
    conversationId: resolveConversationId(input.snapshot, input.prefix),
  };
  const { user, options } = turn;
  if (options.nativeExecCompletion && user.includes("Exec completed ("))
    return replyToNativeCompletion(turn);
  if (user.includes("Keep this turn busy."))
    return respond(turn, { content: "NO_REPLY", gate: options.siblingGate });
  if (user.includes("Continue in this same thread."))
    return respond(turn, { content: "SAME_SESSION_CONTINUED" });
  if (user.includes(RACING_HUMAN)) return respond(turn, { content: RACING_HUMAN_HANDLED });
  if (user.includes(HUMAN_DURING_SEED))
    return respond(turn, { content: HUMAN_DURING_SEED_HANDLED });
  if (user.includes(TAKEOVER_MESSAGE)) return replyToTakeover(turn);
  if (user.includes(RESTART_RECOVERY_PROMPT)) return respond(turn, { content: SILENT_TOKEN });
  return replyToParent(turn);
}

function resolveConversationId(snapshot: Snapshot, prompt: string): string {
  const conversation = snapshot.conversations.findLast((candidate) =>
    prompt.includes(candidate.id),
  );
  if (!conversation)
    throw new Error("Provider could not resolve conversation from current segment");
  return conversation.id;
}

function replyToNativeCompletion(turn: Turn): ProviderReply {
  if (!turn.issued)
    return respond(turn, { tool: "thread_handoff", arguments: { action: "claim" } });
  if (!isClaim(turn.issued)) throw new Error("Native completion did not return its own claim");
  if (turn.status === "alreadyClaimed")
    return respond(turn, { content: "NATIVE_COMPLETION_REPORTED" });
  if (turn.status === "error" && turn.options.dropCompletionRoute)
    return respond(turn, { content: "NATIVE_COMPLETION_CLAIM_REJECTED" });
  throw new Error(`Unexpected native completion claim: ${turn.status}`);
}

function isClaim(issued: IssuedCall): boolean {
  return issued.name === "thread_handoff" && issued.arguments.action === "claim";
}

function replyToTakeover(turn: Turn): ProviderReply {
  const { options, issued, status, flow, resultText } = turn;
  if (options.holdFirstSeed) return respond(turn, { content: SILENT_TOKEN });
  if (!issued) return respond(turn, { tool: "thread_handoff", arguments: { action: "claim" } });
  if (isClaim(issued)) {
    if (status === "alreadyClaimed") return respond(turn, { content: SILENT_TOKEN });
    if (status !== "claimed") throw new Error(`Unexpected takeover claim: ${status}`);
    if (options.claimTwice && !flow.repeatedClaim) {
      flow.repeatedClaim = true;
      return respond(turn, { tool: "thread_handoff", arguments: { action: "claim" } });
    }
    const threadId = resolveThreadId(turn.surface, turn.snapshot, turn.conversationId);
    return respond(turn, {
      tool: "message",
      arguments: {
        action: "read",
        channel: `${turn.surface}-mock`,
        target: `channel:${turn.surface === "slack" ? turn.conversationId : threadId}`,
        threadId,
      },
    });
  }
  if (issued.name === "exec" && resultText?.includes("Command still running"))
    return respond(turn, { content: SILENT_TOKEN });
  if (
    issued.name !== "message" ||
    issued.arguments.action !== "read" ||
    !resultText?.includes("preserve this exact starter.")
  )
    throw new Error("Unexpected takeover tool result");
  if (options.nativeExecCompletion)
    return respond(turn, {
      tool: "exec",
      arguments: { command: "sleep 2; printf NATIVE_EXEC_OUTPUT", background: true },
    });
  if (options.silenceAfterClaim) return respond(turn, { content: SILENT_TOKEN });
  return respond(turn, { content: MARKER, gate: options.seedGate });
}

export function resolveThreadId(
  surface: Surface,
  snapshot: Snapshot,
  conversationId: string,
): string {
  const threadId =
    surface === "slack"
      ? snapshot.messages.find(
          (message) =>
            message.direction === "inbound" &&
            message.threadId === undefined &&
            message.conversation.id === conversationId,
        )?.id
      : snapshot.threads.find((thread) => thread.conversationId === conversationId)?.id;
  if (threadId === undefined) throw new Error("Provider could not resolve native thread ID");
  return threadId;
}

function replyToParent(turn: Turn): ProviderReply {
  const { issued, status, options, flow, resultText } = turn;
  if (issued?.name === "thread_handoff" && issued.arguments.action === "start") {
    if (status === "queued" && options.duplicateStart && !flow.repeatedStart) {
      flow.repeatedStart = true;
      return startHandoff(turn);
    }
    if (status !== "queued" && status !== "alreadyStarted")
      throw new Error(`Unexpected start: ${status}`);
    return respond(turn, { content: "NO_REPLY" });
  }
  const root = turn.snapshot.messages.find(
    (message) =>
      message.direction === "inbound" &&
      message.threadId === undefined &&
      message.conversation.id === turn.conversationId,
  );
  if (!root || !turn.user.includes(root.text))
    throw new Error("Provider current turn does not match its bus inbound");
  if (issued && issued.name !== "message") throw new Error("Unexpected parent tool result");
  const failed = resultText?.includes("planned recoverable starter failure") === true;
  if (
    issued &&
    !failed &&
    (turn.surface === "slack" ||
      issued.arguments.action === "thread-reply" ||
      options.starterInThreadCreate)
  ) {
    if (options.starterInThreadCreate) return respond(turn, { content: "NO_REPLY" });
    return startHandoff(turn);
  }
  return deliverStarter(turn, root.id);
}

function startHandoff(turn: Turn): ProviderReply {
  return respond(turn, {
    tool: "thread_handoff",
    arguments: {
      action: "start",
      threadId: resolveThreadId(turn.surface, turn.snapshot, turn.conversationId),
    },
  });
}

function deliverStarter(turn: Turn, rootId: string): ProviderReply {
  if (turn.surface === "slack")
    return respond(turn, {
      tool: "message",
      arguments: {
        action: "send",
        target: `channel:${turn.conversationId}`,
        threadId: rootId,
        message: STARTER,
      },
    });
  const thread = turn.snapshot.threads.find(
    (candidate) => candidate.conversationId === turn.conversationId,
  );
  if (thread)
    return respond(turn, {
      tool: "message",
      arguments: { action: "thread-reply", threadId: thread.id, message: STARTER },
    });
  return respond(turn, {
    tool: "message",
    arguments: {
      action: "thread-create",
      target: `channel:${turn.conversationId}`,
      threadName: `${turn.conversationId} work`,
      messageId: rootId,
      ...(turn.options.starterInThreadCreate ? { message: STARTER } : {}),
    },
  });
}

function respond(turn: Turn, next: Omit<ProviderReply, "id">): ProviderReply {
  if (next.tool)
    turn.flow.issued.set(turn.id, { name: next.tool, arguments: next.arguments ?? {} });
  return { id: turn.id, ...next };
}

export function createProviderGate(): ProviderGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered: false,
    released: false,
    async hold() {
      this.entered = true;
      await promise;
    },
    release() {
      this.released = true;
      release();
    },
  };
}
