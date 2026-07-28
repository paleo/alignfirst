import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createInboundEnvelopeBuilder,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "openclaw/plugin-sdk/inbound-envelope";
import {
  buildAgentMediaPayload,
  saveMediaBuffer,
  saveMediaSource,
} from "openclaw/plugin-sdk/media-runtime";
import { buildAgentSessionKey, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { buildQaTarget, sendQaBusMessage } from "./bus-client.js";
import type { ChannelSurface } from "./plugin-actions.js";
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
  // Slack auto-thread on a root inbound: every outbound of this turn is delivered into the thread
  // rooted on the triggering message (`autoThreadId === inbound.id`, Slack's `thread_ts = ts` — no
  // separate thread object exists). The same id rides the inbound context as `MessageThreadId`, so
  // OpenClaw captures it as the turn's current thread and a later background-exec wake replies back
  // into it (the real-Slack behavior).
  autoThreadId?: string;
}): (payload: unknown) => Promise<void> {
  const { account, inbound, target, toolCalls, autoThreadId } = params;
  let autoThreadDeliveries = 0;

  return async (payload: unknown) => {
    const text = extractDeliveryText(payload);
    if (!text.trim()) {
      return;
    }
    if (autoThreadId) {
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
  surface: ChannelSurface;
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
  // The route resolves against the conversation ROOT, as the real plugins do (Slack routes on the
  // channel id, Discord re-keys the thread in `resolveInboundSessionKey`) — the thread id never
  // shapes the routing peer.
  const rootTarget = buildQaTarget({
    chatType: inbound.conversation.kind,
    conversationId: inbound.conversation.id,
  });
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
      id: rootTarget,
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

  // Slack auto-threads a root inbound on the triggering message itself: the thread id IS the root
  // message's id (Slack's `thread_ts = ts`) and no thread object is created — exactly what the real
  // Slack plugin does under `replyToMode: "all"` (`resolveSlackThreadContext`). The turn stays on
  // the channel session (the session key ignores this id); the id is surfaced as `MessageThreadId`
  // below so OpenClaw captures it as the turn's current thread — that's what lets a background-exec
  // exit wake reply back into the thread instead of the channel root.
  const autoThreadId = params.autoThread && !inbound.threadId ? inbound.id : undefined;

  const sessionKey = resolveInboundSessionKey({
    surface: params.surface,
    channelId: params.channelId,
    route,
    threadId: inbound.threadId,
  });
  const buildSessionEnvelope =
    sessionKey === route.sessionKey
      ? buildEnvelope
      : createThreadSessionEnvelopeBuilder({
          runtime,
          config: params.config,
          agentId: route.agentId,
          sessionKey,
        });
  const { storePath, body } = buildSessionEnvelope({
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
    SessionKey: sessionKey,
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
    // On a Slack auto-thread root this is the inbound message's own id (thread_ts = ts), mirroring
    // the real Slack plugin under `replyToMode: "all"`: the turn is still dispatched as a channel
    // turn, but OpenClaw captures the id as `currentThreadTs` when a background `exec` launches, so
    // the exit wake threads its reply. The playbook dispatcher distinguishes a root turn from a
    // thread turn by `topic_id === message_id`, exactly as on real Slack.
    MessageThreadId: inbound.threadId ?? autoThreadId,
    ThreadLabel: inbound.threadTitle,
    ThreadParentId: (inbound.threadId ?? autoThreadId) ? inbound.conversation.id : undefined,
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

  await runtime.channel.inbound.dispatchReply({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    agentId: route.agentId,
    routeSessionKey: sessionKey,
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
        autoThreadId,
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

/**
 * A thread inbound activates a per-thread session keyed exactly like the real channel plugin.
 * Discord: a thread IS a channel, so the key is built from the thread's own id
 * (`message-handler.context.ts` — `buildAgentSessionKey` with peer `{ kind: "channel" }`, then
 * `resolveThreadSessionKeys` with `useSuffix: false`, an identity). Slack: the channel session key
 * gets the default `:thread:<threadTs>` suffix (`prepare-routing.ts`). Root inbounds — including
 * Slack auto-thread roots, whose `autoThreadId` never touches the session key — stay on the
 * channel session.
 */
function resolveInboundSessionKey(params: {
  surface: ChannelSurface;
  channelId: string;
  route: { agentId: string; sessionKey: string };
  threadId: string | undefined;
}): string {
  if (params.threadId === undefined) return params.route.sessionKey;
  if (params.surface === "discord") {
    return buildAgentSessionKey({
      agentId: params.route.agentId,
      channel: params.channelId,
      peer: { kind: "channel", id: params.threadId },
    });
  }
  return resolveThreadSessionKeys({
    baseSessionKey: params.route.sessionKey,
    threadId: params.threadId,
  }).sessionKey;
}

// The envelope's "previous message" timestamp must come from the session that receives the turn —
// the real plugins re-read it with the thread-resolved key (Discord's `effectiveSessionKey`
// re-read, Slack's `threadKeys.sessionKey`), not the raw route key. The store path itself depends
// only on the agent id and is unaffected.
function createThreadSessionEnvelopeBuilder(params: {
  runtime: PluginRuntime;
  config: CoreConfig;
  agentId: string;
  sessionKey: string;
}) {
  const channel = params.runtime.channel;
  return createInboundEnvelopeBuilder({
    cfg: params.config as OpenClawConfig,
    route: { agentId: params.agentId, sessionKey: params.sessionKey },
    sessionStore: params.config.session?.store,
    resolveStorePath: channel.session.resolveStorePath,
    readSessionUpdatedAt: channel.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: channel.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: channel.reply.formatAgentEnvelope,
  });
}
