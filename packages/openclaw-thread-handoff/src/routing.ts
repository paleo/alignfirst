import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildAgentSessionKey,
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
  resolveThreadSessionKeys,
} from "openclaw/plugin-sdk/routing";
import { HandoffError } from "./errors.js";
import type {
  DeliveryReceipt,
  DeliveryRoute,
  HandoffRecord,
  PluginConfiguration,
  SourceContext,
} from "./types.js";

export interface ResolvedHandoffRoute {
  routeKey: string;
  targetSessionKey: string;
  deliveryContext: DeliveryRoute;
}

export function readSourceContext(
  context: OpenClawPluginToolContext,
  configuration: PluginConfiguration,
): SourceContext | undefined {
  const deliveryContext = readDeliveryContext(context.deliveryContext);
  const agentId = nonempty(context.agentId);
  const sessionKey = nonempty(context.sessionKey);
  const sessionId = nonempty(context.sessionId);
  const channelId = nonempty(context.messageChannel) ?? deliveryContext?.channel;
  const parentConversationId =
    nonempty(context.nativeChannelId) ?? readConversationId(deliveryContext?.to);
  const accountId = nonempty(context.agentAccountId) ?? deliveryContext?.accountId;
  if (!agentId || !sessionKey || !sessionId || !channelId || !parentConversationId) return;
  if (!configuration.channelSurfaces[channelId]) return;
  return {
    agentId,
    sessionKey,
    sessionId,
    channelId,
    ...(accountId ? { accountId } : {}),
    parentConversationId,
    ...(deliveryContext ? { deliveryContext } : {}),
  };
}

function readConversationId(target: string | undefined): string | undefined {
  if (!target) return;
  const thread = /^thread:([^/]+)\/.+/u.exec(target);
  if (thread) return thread[1];
  const routed = /^(?:channel|group|dm):(.+)$/u.exec(target);
  return routed?.[1];
}

function readDeliveryContext(value: unknown): DeliveryRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const channel = nonempty(Reflect.get(value, "channel"));
  const to = nonempty(Reflect.get(value, "to"));
  if (!channel || !to) return;
  const accountId = nonempty(Reflect.get(value, "accountId"));
  const rawThreadId = Reflect.get(value, "threadId");
  const threadId = typeof rawThreadId === "number" ? String(rawThreadId) : nonempty(rawThreadId);
  return {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function assertSupportedSource(
  source: SourceContext,
  configuration: PluginConfiguration,
): "slack" | "discord" {
  const surface = configuration.channelSurfaces[source.channelId];
  if (!surface) {
    throw new HandoffError("unsupportedContext", "This channel is not configured for handoff.");
  }
  if (
    isSubagentSessionKey(source.sessionKey) ||
    isAcpSessionKey(source.sessionKey) ||
    isCronSessionKey(source.sessionKey)
  ) {
    throw new HandoffError(
      "unsupportedContext",
      "Thread handoff requires a regular channel session.",
    );
  }
  const parsed = parseAgentSessionKey(source.sessionKey);
  const thread = parseThreadSessionSuffix(source.sessionKey);
  if (
    !parsed ||
    parsed.agentId !== source.agentId.toLowerCase() ||
    thread.threadId !== undefined ||
    !matchesChannelRoute(parsed.rest, source.channelId, source.parentConversationId)
  ) {
    throw new HandoffError(
      "unsupportedContext",
      "Thread handoff requires a distinct parent-channel session.",
    );
  }
  return surface;
}

function matchesChannelRoute(
  rest: string,
  channelId: string,
  parentConversationId: string,
): boolean {
  const prefix = `${channelId.toLowerCase()}:channel:`;
  if (!rest.startsWith(prefix)) return false;
  const peerId = rest.slice(prefix.length);
  const parent = parentConversationId.toLowerCase();
  return peerId === parent || peerId.endsWith(`:channel:${parent}`);
}

export function resolveHandoffRoute(
  source: SourceContext,
  threadId: string,
  surface: "slack" | "discord",
): ResolvedHandoffRoute {
  const targetSessionKey =
    surface === "slack"
      ? resolveThreadSessionKeys({ baseSessionKey: source.sessionKey, threadId }).sessionKey
      : buildAgentSessionKey({
          agentId: source.agentId,
          channel: source.channelId,
          accountId: source.accountId,
          peer: { kind: "channel", id: threadId },
        });
  if (targetSessionKey === source.sessionKey) {
    throw new HandoffError("invalidTarget", "The target must be a distinct thread session.");
  }
  const deliveryContext: DeliveryRoute =
    surface === "slack"
      ? {
          channel: source.channelId,
          to: `channel:${source.parentConversationId}`,
          threadId,
          ...(source.accountId ? { accountId: source.accountId } : {}),
        }
      : {
          channel: source.channelId,
          to: `channel:${threadId}`,
          ...(source.accountId ? { accountId: source.accountId } : {}),
        };
  return {
    routeKey: JSON.stringify([
      source.agentId,
      source.channelId,
      source.accountId ?? null,
      targetSessionKey,
    ]),
    targetSessionKey,
    deliveryContext,
  };
}

export function createHandoffRecord(params: {
  receipt: DeliveryReceipt;
  route: ResolvedHandoffRoute;
  handoffId: string;
  createdAt: number;
}): HandoffRecord {
  return {
    schemaVersion: 1,
    routeKey: params.route.routeKey,
    handoffId: params.handoffId,
    targetSessionKey: params.route.targetSessionKey,
    agentId: params.receipt.agentId,
    sessionKey: params.receipt.sessionKey,
    sessionId: params.receipt.sessionId,
    channelId: params.receipt.channelId,
    ...(params.receipt.accountId ? { accountId: params.receipt.accountId } : {}),
    parentConversationId: params.receipt.parentConversationId,
    threadId: params.receipt.threadId,
    ...(params.receipt.starterMessageId
      ? { starterMessageId: params.receipt.starterMessageId }
      : {}),
    starterText: params.receipt.starterText,
    deliveryContext: params.route.deliveryContext,
    createdAt: params.createdAt,
    state: "pending",
  };
}

export function evidenceMatches(record: HandoffRecord, receipt: DeliveryReceipt): boolean {
  return (
    record.sessionKey === receipt.sessionKey &&
    record.sessionId === receipt.sessionId &&
    record.channelId === receipt.channelId &&
    record.accountId === receipt.accountId &&
    record.parentConversationId === receipt.parentConversationId &&
    record.threadId === receipt.threadId &&
    record.starterMessageId === receipt.starterMessageId &&
    record.starterText === receipt.starterText
  );
}

function nonempty(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
