import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID, createChannelMockAccountHelpers } from "./accounts.js";
import { buildQaTarget, normalizeQaTarget, parseQaTarget } from "./bus-client.js";
import { createChannelMockMeta } from "./channel-meta.js";
import { buildChannelMockConfigSchema } from "./config-schema.js";
import { startChannelMockGatewayAccount } from "./gateway.js";
import { createSendChannelMockText } from "./outbound.js";
import { createChannelMockMessageActions, type ChannelSurface } from "./plugin-actions.js";
import type { ChannelPlugin, PluginRuntime } from "./runtime-api.js";
import { createApplyChannelMockSetup } from "./setup.js";
import { createChannelMockStatus } from "./status.js";
import type { CoreConfig, ResolvedChannelMockAccount } from "./types.js";

export function createChannelMockPlugin(params: {
  channelId: string;
  label: string;
  surface: ChannelSurface;
  autoThread: boolean;
  getRuntime: () => PluginRuntime;
}): ChannelPlugin<ResolvedChannelMockAccount> {
  const { channelId, label, surface, autoThread, getRuntime } = params;
  const meta = createChannelMockMeta({ channelId, label, surface });
  const helpers = createChannelMockAccountHelpers({ channelId });
  const applySetup = createApplyChannelMockSetup({ channelId });
  const sendText = createSendChannelMockText({ helpers });
  const messageActions = createChannelMockMessageActions({ channelId, surface, helpers });
  const status = createChannelMockStatus();
  const configSchema = buildChannelMockConfigSchema(channelId);

  const messageAdapter = defineChannelMessageAdapter({
    id: channelId,
    durableFinal: {
      capabilities: {
        text: true,
        replyTo: true,
        thread: true,
        messageSendingHooks: true,
      },
    },
    send: {
      text: async (ctx) => {
        const result = await sendText({
          cfg: ctx.cfg as CoreConfig,
          accountId: ctx.accountId,
          to: ctx.to,
          text: ctx.text,
          threadId: ctx.threadId,
          replyToId: ctx.replyToId,
        });
        const threadId = ctx.threadId == null ? undefined : String(ctx.threadId);
        const replyToId = ctx.replyToId ?? undefined;
        return {
          messageId: result.messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: channelId, messageId: result.messageId }],
            threadId,
            replyToId,
            kind: "text",
          }),
        };
      },
    },
  });

  return createChatChannelPlugin({
    base: {
      id: channelId,
      meta,
      capabilities: {
        chatTypes: ["direct", "group"],
      },
      reload: { configPrefixes: [`channels.${channelId}`] },
      configSchema,
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) =>
          applySetup({ cfg, accountId, input: input as Record<string, unknown> }),
      },
      config: {
        listAccountIds: (cfg) => helpers.listAccountIds(cfg as CoreConfig),
        resolveAccount: (cfg, accountId) =>
          helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }),
        defaultAccountId: (cfg) => helpers.resolveDefaultAccountId(cfg as CoreConfig),
        isConfigured: (account) => account.configured,
        resolveAllowFrom: ({ cfg, accountId }) =>
          helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
        resolveDefaultTo: ({ cfg, accountId }) =>
          helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
      },
      messaging: {
        normalizeTarget: normalizeQaTarget,
        inferTargetChatType: ({ to }) => parseQaTarget(to).chatType,
        targetResolver: {
          looksLikeId: (raw) => raw.trim().length > 0,
          hint: "<dm:user|channel:room|group:room|thread:room/thread>",
        },
        resolveOutboundSessionRoute: ({
          cfg,
          agentId,
          accountId,
          target,
          replyToId,
          threadId,
          currentSessionKey,
        }) => {
          const parsed = parseQaTarget(target);
          const baseRoute = buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: channelId,
            accountId,
            peer: {
              kind:
                parsed.chatType === "direct"
                  ? "direct"
                  : parsed.chatType === "group"
                    ? "group"
                    : "channel",
              id: parsed.conversationId,
            },
            chatType: parsed.chatType,
            from: `${channelId}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
            to: buildQaTarget(parsed),
          });
          return buildThreadAwareOutboundSessionRoute({
            route: baseRoute,
            replyToId,
            threadId:
              threadId ?? (target.trim().startsWith("thread:") ? undefined : parsed.threadId),
            currentSessionKey,
            canRecoverCurrentThread: ({ route }) =>
              route.chatType !== "direct" || (cfg.session?.dmScope ?? "main") !== "main",
          });
        },
        resolveSessionConversation: ({ rawId }) => {
          const parsed = parseQaTarget(rawId);
          if (parsed.chatType === "direct") {
            return null;
          }
          return {
            id: parsed.conversationId,
            threadId: parsed.threadId,
            baseConversationId: parsed.conversationId,
            parentConversationCandidates: [parsed.conversationId],
          };
        },
      },
      status,
      gateway: {
        startAccount: async (ctx) => {
          await startChannelMockGatewayAccount({
            channelId,
            channelLabel: meta.label,
            ctx,
            surface,
            autoThread,
            getRuntime,
          });
        },
      },
      actions: messageActions,
      message: messageAdapter,
      // Mirrors real Slack: coalesce intermediate block-stream chunks so each
      // user-facing text emitted by the agent becomes its own bus message
      // instead of accumulating into the final reply.
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1, idleMs: 100 },
      },
    },
    // Slack-shaped channels expose the turn's thread to the tool layer (real Slack's
    // `threading.buildToolContext`): `currentThreadTs` is what a background `exec` captures at
    // launch, and what lets its exit wake reply into the originating thread instead of the channel
    // root. Discord-shaped channels stay without the hook — real Discord doesn't define one.
    ...(surface === "slack"
      ? {
          threading: {
            threadAddressing: "message" as const,
            scopedAccountReplyToMode: {
              resolveAccount: (cfg: CoreConfig, accountId?: string | null) =>
                helpers.resolveAccount({ cfg, accountId }),
              resolveReplyToMode: (account: ResolvedChannelMockAccount) =>
                account.config.replyToMode ?? "all",
            },
            allowExplicitReplyTagsWhenOff: false,
            buildToolContext: buildSlackShapedThreadingToolContext,
          },
        }
      : {}),
    outbound: {
      base: {
        deliveryMode: "direct",
        deliveryCapabilities: {
          durableFinal: {
            text: true,
            replyTo: true,
            thread: true,
            messageSendingHooks: true,
          },
        },
      },
      attachedResults: {
        channel: channelId,
        sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) =>
          await sendText({
            cfg: cfg as CoreConfig,
            accountId,
            to,
            text,
            threadId,
            replyToId,
          }),
      },
    },
  });
}

// Mirrors `buildSlackThreadingToolContext` (extensions/slack/src/threading-tool-context.ts) on the
// mock's target shapes. Thread ids here are plain strings (the auto-thread is rooted on the inbound
// message id — Slack's `thread_ts = ts`), so no ts-format normalization is needed.
function buildSlackShapedThreadingToolContext(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const { context, hasRepliedRef } = params;
  const messageThreadId = normalizeThreadValue(context.MessageThreadId);
  const transportThreadId = normalizeThreadValue(context.TransportThreadId);
  const replyToId = normalizeThreadValue(context.ReplyToId);
  const currentMessageId = normalizeThreadValue(context.CurrentMessageId);
  const currentThreadTs = messageThreadId ?? transportThreadId ?? replyToId;
  const hasExplicitThreadTarget =
    messageThreadId != null ||
    transportThreadId != null ||
    (replyToId != null && currentMessageId != null && replyToId !== currentMessageId);
  const currentMessagingTarget = normalizeThreadValue(context.To);
  return {
    ...(currentMessagingTarget !== undefined
      ? { currentChannelId: currentMessagingTarget, currentMessagingTarget }
      : {}),
    ...(currentThreadTs !== undefined ? { currentThreadTs } : {}),
    replyToMode: hasExplicitThreadTarget ? "all" : (context.ReplyToMode ?? "all"),
    hasRepliedRef,
    sameChannelThreadRequired: hasExplicitThreadTarget,
  };
}

function normalizeThreadValue(value: string | number | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}
