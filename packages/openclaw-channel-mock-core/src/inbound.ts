import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  buildAgentMediaPayload,
  saveMediaBuffer,
  saveMediaSource,
} from "openclaw/plugin-sdk/media-runtime";
import { buildQaTarget, createQaBusThread, sendQaBusMessage } from "./bus-client.js";
import {
  sanitizeQaBusToolCallArguments,
  type QaBusMessage,
  type QaBusToolCall,
} from "./protocol.js";
import type { PluginRuntime } from "./runtime-api.js";
import type { CoreConfig, ResolvedChannelMockAccount } from "./types.js";

export function isHttpMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeAttachmentBase64(value: string): Buffer | null {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    return null;
  }
  return buffer;
}

async function resolveInboundMediaPayload(attachments: QaBusMessage["attachments"]) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {};
  }
  const mediaList: Array<{ path: string; contentType?: string | null }> = [];
  for (const attachment of attachments) {
    if (!attachment?.mimeType) {
      continue;
    }
    if (typeof attachment.contentBase64 === "string" && attachment.contentBase64.trim()) {
      const buffer = decodeAttachmentBase64(attachment.contentBase64);
      if (!buffer) {
        console.warn("[channel-mock] inbound attachment contentBase64 rejected (invalid base64)");
        continue;
      }
      const saved = await saveMediaBuffer(
        buffer,
        attachment.mimeType,
        "inbound",
        undefined,
        attachment.fileName,
      );
      mediaList.push({ path: saved.path, contentType: saved.contentType });
      continue;
    }
    if (typeof attachment.url === "string" && attachment.url.trim()) {
      if (!isHttpMediaUrl(attachment.url)) {
        console.warn(
          `[channel-mock] inbound attachment URL rejected (non-http scheme): ${attachment.url}`,
        );
        continue;
      }
      const saved = await saveMediaSource(attachment.url, undefined, "inbound");
      mediaList.push({ path: saved.path, contentType: saved.contentType });
    }
  }
  return mediaList.length > 0 ? buildAgentMediaPayload(mediaList) : {};
}

function resolveGroupConfig(params: {
  account: ResolvedChannelMockAccount;
  conversationId: string;
  target: string;
}) {
  const groups = params.account.config.groups;
  return groups?.[params.conversationId] ?? groups?.[params.target] ?? groups?.["*"];
}

function extractDeliveryText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    return (payload as { text?: string }).text ?? "";
  }
  return "";
}

export function buildDeliveryCallback(params: {
  account: ResolvedChannelMockAccount;
  inbound: QaBusMessage;
  target: string;
  toolCalls: QaBusToolCall[];
  autoThread: boolean;
}): (payload: unknown) => Promise<void> {
  const { account, inbound, target, toolCalls, autoThread } = params;
  const slackAutoThread = autoThread && !inbound.threadId;
  let autoThreadId: string | undefined;
  let autoThreadDeliveries = 0;

  return async (payload: unknown) => {
    const text = extractDeliveryText(payload);
    if (!text.trim()) {
      return;
    }
    if (slackAutoThread) {
      if (!autoThreadId) {
        const title =
          inbound.threadTitle?.trim() ||
          inbound.conversation.title?.trim() ||
          inbound.text.slice(0, 60) ||
          "thread";
        const { thread } = await createQaBusThread({
          baseUrl: account.baseUrl,
          accountId: account.accountId,
          conversationId: inbound.conversation.id,
          title,
          createdBy: account.botUserId,
        });
        autoThreadId = thread.id;
      }
      autoThreadDeliveries += 1;
      await sendQaBusMessage({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        to: `thread:${inbound.conversation.id}/${autoThreadId}`,
        text,
        senderId: account.botUserId,
        senderName: account.botDisplayName,
        threadId: autoThreadId,
        replyToId: autoThreadDeliveries === 1 ? inbound.id : undefined,
        toolCalls,
      });
      return;
    }
    await sendQaBusMessage({
      baseUrl: account.baseUrl,
      accountId: account.accountId,
      to: target,
      text,
      senderId: account.botUserId,
      senderName: account.botDisplayName,
      threadId: inbound.threadId,
      replyToId: inbound.id,
      toolCalls,
    });
  };
}

export async function handleInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedChannelMockAccount;
  config: CoreConfig;
  message: QaBusMessage;
  autoThread: boolean;
  getRuntime: () => PluginRuntime;
}) {
  const runtime = params.getRuntime();
  const inbound = params.message;
  const target = buildQaTarget({
    chatType: inbound.conversation.kind,
    conversationId: inbound.conversation.id,
    threadId: inbound.threadId,
  });
  const toolCalls: QaBusToolCall[] = [];
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    peer: {
      kind:
        inbound.conversation.kind === "direct"
          ? "direct"
          : inbound.conversation.kind === "group"
            ? "group"
            : "channel",
      id: target,
    },
    runtime: runtime.channel,
    sessionStore: params.config.session?.store,
  });
  const isGroup = inbound.conversation.kind !== "direct";
  const wasMentioned = isGroup
    ? runtime.channel.mentions.matchesMentionPatterns(
        inbound.text,
        runtime.channel.mentions.buildMentionRegexes(
          params.config as OpenClawConfig,
          route.agentId,
        ),
      )
    : undefined;
  const groupConfig = isGroup
    ? resolveGroupConfig({
        account: params.account,
        conversationId: inbound.conversation.id,
        target,
      })
    : undefined;
  const access = await resolveStableChannelMessageIngress({
    channelId: params.channelId,
    accountId: params.account.accountId,
    identity: { key: "sender", entryIdPrefix: `${params.channelId}-entry` },
    groupAllowFromFallbackToAllowFrom: true,
    subject: { stableId: inbound.senderId },
    conversation: {
      kind: inbound.conversation.kind,
      id: inbound.conversation.id,
      threadId: inbound.threadId,
      title: inbound.conversation.title,
    },
    mentionFacts: isGroup
      ? { canDetectMention: true, wasMentioned: wasMentioned ?? false }
      : undefined,
    dmPolicy: "open",
    groupPolicy: params.account.config.groupPolicy ?? "open",
    policy: {
      activation: isGroup
        ? { requireMention: groupConfig?.requireMention ?? false, allowTextCommands: true }
        : undefined,
    },
    allowFrom: params.account.config.allowFrom,
    groupAllowFrom: params.account.config.groupAllowFrom,
  });
  if (access.ingress.admission !== "dispatch") {
    return;
  }
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: inbound.senderName || inbound.senderId,
    timestamp: inbound.timestamp,
    body: inbound.text,
  });
  const mediaPayload = await resolveInboundMediaPayload(inbound.attachments);

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: inbound.conversation.kind === "direct" ? "direct" : "group",
    WasMentioned: wasMentioned,
    ConversationLabel:
      inbound.threadTitle ||
      inbound.conversation.title ||
      inbound.senderName ||
      inbound.conversation.id,
    GroupSubject: isGroup
      ? inbound.threadTitle || inbound.conversation.title || inbound.conversation.id
      : undefined,
    GroupChannel: inbound.conversation.kind === "channel" ? inbound.conversation.id : undefined,
    NativeChannelId: inbound.conversation.id,
    MessageThreadId: inbound.threadId,
    ThreadLabel: inbound.threadTitle,
    ThreadParentId: inbound.threadId ? inbound.conversation.id : undefined,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    Provider: params.channelId,
    Surface: params.channelId,
    MessageSid: inbound.id,
    MessageSidFull: inbound.id,
    ReplyToId: inbound.replyToId,
    Timestamp: inbound.timestamp,
    OriginatingChannel: params.channelId,
    OriginatingTo: target,
    CommandAuthorized: true,
    ...mediaPayload,
  });

  await runtime.channel.turn.runAssembled({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: buildDeliveryCallback({
        account: params.account,
        inbound,
        target,
        toolCalls,
        autoThread: params.autoThread,
      }),
      onError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`${params.channelId} dispatch failed: ${String(error)}`);
      },
    },
    replyOptions: {
      onToolStart: (payload) => {
        if (payload.phase && payload.phase !== "start") {
          return;
        }
        const name = payload.name?.trim();
        if (!name) {
          return;
        }
        const args = sanitizeQaBusToolCallArguments(payload.args);
        toolCalls.push({
          name,
          ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
        });
      },
    },
    replyPipeline: {},
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`${params.channelId} session record failed: ${String(error)}`);
      },
    },
  });
}
