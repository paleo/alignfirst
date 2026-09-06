import { createHash } from "node:crypto";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { HandoffStore } from "./state.js";
import type { DeliveryReceipt, PluginConfiguration, SourceContext } from "./types.js";
import { readSourceContext } from "./routing.js";

const RECEIPT_TTL_MS = 60 * 60 * 1_000;
const CONTEXT_LIMIT = 10_000;
const RECEIPT_WAIT_MS = 1_000;
const RECEIPT_POLL_MS = 25;

export interface ReceiptCoordinator {
  captureContext(context: OpenClawPluginToolContext): void;
  observe(event: ToolObservation, context: HookContext): void;
  waitForReceipt(identity: ReceiptLookup): Promise<DeliveryReceipt | undefined>;
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

export interface ReceiptLookup {
  sourceSessionKey: string;
  sourceSessionId: string;
  threadId: string;
}

interface CachedContext {
  source: SourceContext;
  capturedAt: number;
}

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
      const receipt = parseDeliveryReceipt({
        event,
        source,
        surface: params.configuration.channelSurfaces[source.channelId],
        now: now(),
      });
      if (!receipt) return;
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
}): DeliveryReceipt | undefined {
  if (params.surface === "slack") return parseSlackReceipt(params);
  if (params.surface === "discord") return parseDiscordReceipt(params);
  return;
}

function parseSlackReceipt(params: {
  event: ToolObservation;
  source: SourceContext;
  now: number;
}): DeliveryReceipt | undefined {
  const { event, source } = params;
  if (event.params.action !== "send") return;
  const threadId = nonempty(event.params.threadId);
  const starterText = readStarter(event.params);
  const destination = readDestination(event.params);
  const details = readResultDetails(event.result);
  const result = asRecord(details?.result);
  if (
    !threadId ||
    starterText === undefined ||
    details?.ok !== true ||
    details.partial === true ||
    !result ||
    !matchesConversation(destination, source.parentConversationId) ||
    nonempty(result.channelId)?.toLowerCase() !== source.parentConversationId.toLowerCase() ||
    (nonempty(result.threadTs) !== undefined && nonempty(result.threadTs) !== threadId)
  ) {
    return;
  }
  const starterMessageId = nonempty(result.messageId);
  if (!starterMessageId || !accountMatches(event.params, source.accountId)) return;
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
}): DeliveryReceipt | undefined {
  const { event, source } = params;
  if (event.params.action !== "thread-create") return;
  const starterText = readStarter(event.params);
  const destination = readDestination(event.params);
  const anchorMessageId = nonempty(event.params.messageId);
  const details = readResultDetails(event.result);
  const thread = asRecord(details?.thread);
  const threadId = nonempty(thread?.id);
  if (
    starterText === undefined ||
    !anchorMessageId ||
    details?.ok !== true ||
    details.partial === true ||
    !threadId ||
    !matchesConversation(destination, source.parentConversationId) ||
    !accountMatches(event.params, source.accountId)
  ) {
    return;
  }
  const returnedParent = nonempty(thread?.parent_id) ?? nonempty(thread?.parentId);
  if (
    returnedParent &&
    returnedParent.toLowerCase() !== source.parentConversationId.toLowerCase()
  ) {
    return;
  }
  return createReceipt({
    source,
    threadId,
    starterText,
    toolCallId: event.toolCallId,
    now: params.now,
  });
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contextKey(sessionKey: string, sessionId: string): string {
  return `${sessionKey}\u0000${sessionId}`;
}

function lookupKey(sessionKey: string, sessionId: string, threadId: string): string {
  return `${contextKey(sessionKey, sessionId)}\u0000${threadId}`;
}

function nonempty(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
