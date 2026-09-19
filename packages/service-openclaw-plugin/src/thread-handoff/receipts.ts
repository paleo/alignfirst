import { createHash } from "node:crypto";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { readSourceContext } from "./routing.js";
import type { HandoffStore } from "./state.js";
import type {
  DeliveryReceipt,
  PluginConfiguration,
  ReceiptIdentity,
  SourceContext,
} from "./types.js";
import { asRecord, nonempty } from "./values.js";

const RECEIPT_TTL_MS = 60 * 60 * 1_000;
const CONTEXT_LIMIT = 10_000;
const RECEIPT_WAIT_MS = 1_000;
const RECEIPT_POLL_MS = 25;

export interface ReceiptCoordinator {
  captureContext(context: OpenClawPluginToolContext): void;
  observe(event: ToolObservation, context: HookContext): void;
  waitForReceipt(identity: ReceiptIdentity): Promise<DeliveryReceipt | undefined>;
}

interface ToolObservation {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: string;
}

interface HookContext {
  sessionKey?: string;
  sessionId?: string;
}

interface CachedContext {
  source: SourceContext;
  capturedAt: number;
}

type RejectionReason =
  | "unsupportedResultShape"
  | "notSent"
  | "partialDelivery"
  | "channelMismatch"
  | "threadMismatch"
  | "missingMessageId"
  | "missingThread"
  | "missingStarter"
  | "accountMismatch";

type ReceiptParseResult = DeliveryReceipt | RejectionReason;

export function createReceiptCoordinator(params: {
  configuration: PluginConfiguration;
  getStore: () => HandoffStore;
  logger: PluginLogger;
  now?: () => number;
}): ReceiptCoordinator {
  const now = params.now ?? Date.now;
  const contexts = new Map<string, CachedContext>();
  const observationErrors = new Map<string, Error>();
  return {
    captureContext(context) {
      const source = readSourceContext(context, params.configuration);
      if (!source) return;
      contexts.set(contextKey(source.sessionKey, source.sessionId), { source, capturedAt: now() });
      pruneContexts(contexts, now());
    },
    observe(event, context) {
      const source = readCachedSource(contexts, context, now());
      if (!source || event.toolName !== "message" || event.error !== undefined) return;
      const surface = params.configuration.channelSurfaces[source.channelId];
      const receipt = parseDeliveryReceipt({
        event,
        source,
        surface,
        now: now(),
      });
      if (!receipt) return;
      if (typeof receipt === "string") {
        const threadId = readObservedThreadId(event, surface);
        params.logger.debug?.(
          `thread-handoff receipt rejected: surface=${surface} session=${source.sessionKey} thread=${threadId ?? "-"} reason=${receipt}`,
        );
        return;
      }
      const key = lookupKey(receipt.sessionKey, receipt.sessionId, receipt.threadId);
      try {
        params.getStore().insertReceipt(receipt, now());
        observationErrors.delete(key);
      } catch (error) {
        const storedError = error instanceof Error ? error : new Error(String(error));
        observationErrors.set(key, storedError);
        params.logger.error(`thread-handoff receipt persistence failed: ${storedError.message}`);
      }
    },
    async waitForReceipt(identity) {
      const key = lookupKey(identity.sourceSessionKey, identity.sourceSessionId, identity.threadId);
      const deadline = now() + RECEIPT_WAIT_MS;
      while (true) {
        const error = observationErrors.get(key);
        if (error) throw error;
        const receipt = params.getStore().findReceipt(identity, now());
        if (receipt || now() >= deadline) return receipt;
        await delay(RECEIPT_POLL_MS);
      }
    },
  };
}

function readCachedSource(
  contexts: Map<string, CachedContext>,
  context: HookContext,
  now: number,
): SourceContext | undefined {
  const sessionKey = nonempty(context.sessionKey);
  const sessionId = nonempty(context.sessionId);
  if (!sessionKey || !sessionId) return;
  pruneContexts(contexts, now);
  return contexts.get(contextKey(sessionKey, sessionId))?.source;
}

function pruneContexts(contexts: Map<string, CachedContext>, now: number): void {
  for (const [key, value] of contexts) {
    if (value.capturedAt + RECEIPT_TTL_MS <= now) contexts.delete(key);
  }
  while (contexts.size > CONTEXT_LIMIT) {
    const oldest = contexts.keys().next().value;
    if (typeof oldest !== "string") return;
    contexts.delete(oldest);
  }
}

function parseDeliveryReceipt(params: {
  event: ToolObservation;
  source: SourceContext;
  surface?: "slack" | "discord";
  now: number;
}): ReceiptParseResult | undefined {
  if (params.surface === "slack" && params.event.params.action === "send") {
    return parseSlackReceipt(params);
  }
  if (params.surface === "discord" && params.event.params.action === "thread-create") {
    return parseDiscordReceipt(params);
  }
  return;
}

function parseSlackReceipt(params: {
  event: ToolObservation;
  source: SourceContext;
  now: number;
}): ReceiptParseResult {
  const { event, source } = params;
  const threadId = nonempty(event.params.threadId);
  if (!threadId) return "missingThread";
  const starterText = readStarter(event.params);
  if (starterText === undefined) return "missingStarter";
  const destination = readDestination(event.params);
  const details = readResultDetails(event.result);
  const result = asRecord(details?.result);
  const target = asRecord(result?.target);
  const targetKind = nonempty(target?.kind);
  const targetId = nonempty(target?.id);
  if (targetKind === undefined || targetId === undefined) return "unsupportedResultShape";
  if (
    !matchesConversation(destination, source.parentConversationId) ||
    targetKind !== "channel" ||
    targetId.toLowerCase() !== source.parentConversationId.toLowerCase()
  ) {
    return "channelMismatch";
  }
  const messageDelivery = asRecord(details?.messageDelivery);
  if (
    nonempty(details?.deliveryStatus) !== "sent" ||
    nonempty(messageDelivery?.status) !== "settled"
  ) {
    return "notSent";
  }
  if (messageDelivery?.partialDelivery !== false) return "partialDelivery";
  const starterMessageId = nonempty(result?.messageId);
  if (!starterMessageId) return "missingMessageId";
  const deliveryReceipt = asRecord(result?.receipt);
  const returnedThreadId = nonempty(deliveryReceipt?.threadId);
  if (returnedThreadId !== undefined && returnedThreadId !== threadId) return "threadMismatch";
  if (!accountMatches(event.params, source.accountId)) return "accountMismatch";
  return createReceipt({
    source,
    threadId,
    starterText,
    starterMessageId,
    toolCallId: event.toolCallId,
    now: params.now,
  });
}

function parseDiscordReceipt(params: {
  event: ToolObservation;
  source: SourceContext;
  now: number;
}): ReceiptParseResult {
  const { event, source } = params;
  const starterText = readStarter(event.params);
  const destination = readDestination(event.params);
  const anchorMessageId = nonempty(event.params.messageId);
  const details = readResultDetails(event.result);
  const thread = asRecord(details?.thread);
  const threadId = nonempty(thread?.id);
  if (!threadId) return "missingThread";
  if (starterText === undefined) return "missingStarter";
  if (!anchorMessageId) return "missingMessageId";
  const returnedParent = nonempty(thread?.parent_id) ?? nonempty(thread?.parentId);
  if (
    !matchesConversation(destination, source.parentConversationId) ||
    (returnedParent !== undefined &&
      returnedParent.toLowerCase() !== source.parentConversationId.toLowerCase())
  ) {
    return "channelMismatch";
  }
  if (details?.ok !== true) return "notSent";
  if (details.partial === true) return "partialDelivery";
  if (!accountMatches(event.params, source.accountId)) return "accountMismatch";
  return createReceipt({
    source,
    threadId,
    starterText,
    toolCallId: event.toolCallId,
    now: params.now,
  });
}

function readObservedThreadId(
  event: ToolObservation,
  surface: "slack" | "discord" | undefined,
): string | undefined {
  if (surface === "slack") return nonempty(event.params.threadId);
  if (surface !== "discord") return;
  const details = readResultDetails(event.result);
  const thread = asRecord(details?.thread);
  return nonempty(thread?.id);
}

function createReceipt(params: {
  source: SourceContext;
  threadId: string;
  starterText: string;
  starterMessageId?: string;
  toolCallId?: string;
  now: number;
}): DeliveryReceipt {
  const identity = JSON.stringify([
    params.source.sessionKey,
    params.source.sessionId,
    params.source.channelId,
    params.source.accountId ?? null,
    params.source.parentConversationId,
    params.threadId,
    params.starterMessageId ?? null,
    params.starterText,
    params.toolCallId ?? null,
  ]);
  return {
    schemaVersion: 1,
    receiptKey: createHash("sha256").update(identity).digest("hex"),
    ...params.source,
    threadId: params.threadId,
    ...(params.starterMessageId ? { starterMessageId: params.starterMessageId } : {}),
    starterText: params.starterText,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    createdAt: params.now,
    expiresAt: params.now + RECEIPT_TTL_MS,
  };
}

function readResultDetails(value: unknown): Record<string, unknown> | undefined {
  const result = asRecord(value);
  return asRecord(result?.details) ?? result;
}

function readStarter(params: Record<string, unknown>): string | undefined {
  for (const key of ["message", "text", "content"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return;
}

function readDestination(params: Record<string, unknown>): string | undefined {
  return nonempty(params.to) ?? nonempty(params.target) ?? nonempty(params.channelId);
}

function matchesConversation(destination: string | undefined, expected: string): boolean {
  if (!destination) return false;
  const normalized = destination.replace(/^channel:/i, "");
  return normalized.toLowerCase() === expected.toLowerCase();
}

function accountMatches(params: Record<string, unknown>, accountId: string | undefined): boolean {
  const supplied = nonempty(params.accountId);
  return supplied === undefined || supplied === accountId;
}

function contextKey(sessionKey: string, sessionId: string): string {
  return `${sessionKey}\u0000${sessionId}`;
}

function lookupKey(sessionKey: string, sessionId: string, threadId: string): string {
  return `${contextKey(sessionKey, sessionId)}\u0000${threadId}`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
