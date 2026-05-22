import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-message";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { DEFAULT_ACCOUNT_ID, createChannelMockAccountHelpers } from "./accounts.js";
import { buildQaTarget, normalizeQaTarget, parseQaTarget } from "./bus-client.js";
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
  const meta = { ...getChatChannelMeta(channelId), label };
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
        parseExplicitTarget: ({ raw }) => {
          const parsed = parseQaTarget(raw);
          return {
            to: buildQaTarget(parsed),
            threadId: parsed.threadId,
            chatType: parsed.chatType,
          };
        },
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
              id: buildQaTarget(parsed),
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
            autoThread,
            getRuntime,
          });
        },
      },
      actions: messageActions,
      message: messageAdapter,
    },
    outbound: {
      base: {
        deliveryMode: "direct",
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
