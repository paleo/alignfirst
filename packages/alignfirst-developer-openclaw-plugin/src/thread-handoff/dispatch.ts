import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { readConversationId } from "./routing.js";
import type { TurnRequest } from "./types.js";
import { errorMessage } from "./values.js";

export async function dispatchTurn(params: {
  runtime: OpenClawPluginApi["runtime"];
  logger: PluginLogger;
  request: TurnRequest;
}): Promise<void> {
  const { runtime, logger, request } = params;
  const cfg = runtime.config.current();
  await runtime.channel.inbound.dispatchReply({
    // The dispatcher only reads configuration, while the runtime exposes it as readonly.
    cfg: cfg as OpenClawConfig,
    channel: request.channelId,
    ...(request.route.accountId ? { accountId: request.route.accountId } : {}),
    agentId: request.agentId,
    routeSessionKey: request.sessionKey,
    storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: request.agentId,
    }),
    ctxPayload: runtime.channel.reply.finalizeInboundContext(buildTurnContext(request)),
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      // Owning the key prevents core from falling back to the context thread on Discord.
      durable: { to: request.route.to, threadId: request.route.threadId, replyToId: null },
      deliver: async () => ({ visibleReplySent: false }),
      onError: (error, info) =>
        logger.warn(`thread-handoff delivery failed (${info.kind}): ${errorMessage(error)}`),
    },
    replyPipeline: {},
    replyOptions: { disableBlockStreaming: true },
    record: {
      updateLastRoute: buildLastRoute(request),
      onRecordError: (error) =>
        logger.warn(`thread-handoff session record failed: ${errorMessage(error)}`),
    },
  });
}

export function buildTurnContext(request: TurnRequest): Record<string, unknown> {
  const conversationId = readConversationId(request.route.to);
  if (!conversationId) throw new Error(`Invalid delivery target: ${request.route.to}`);
  const groupId = request.parentConversationId ?? conversationId;
  const messageThreadId = request.surface === "slack" ? request.route.threadId : conversationId;
  return {
    Body: request.message,
    BodyForAgent: request.message,
    RawBody: request.message,
    CommandBody: "",
    CommandInterpretationSuppressed: true,
    CommandAuthorized: false,
    SessionKey: request.sessionKey,
    AccountId: request.route.accountId,
    Provider: request.channelId,
    Surface: request.channelId,
    OriginatingChannel: request.channelId,
    From: request.route.to,
    To: request.route.to,
    OriginatingTo: request.route.to,
    NativeChannelId:
      request.surface === "slack"
        ? (request.parentConversationId ?? conversationId)
        : conversationId,
    ChatType: "group",
    GroupChannel: groupId,
    ConversationLabel: groupId,
    GroupSubject: groupId,
    MessageThreadId: messageThreadId,
    ...(request.parentConversationId ? { ThreadParentId: request.parentConversationId } : {}),
    WasMentioned: false,
    SenderName: "AlignFirst Service",
    MessageSid: request.messageId,
    MessageSidFull: request.messageId,
    Timestamp: Date.now(),
  };
}

export function buildLastRoute(request: TurnRequest): {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
} {
  return {
    sessionKey: request.sessionKey,
    channel: request.route.channel,
    to: request.route.to,
    ...(request.route.accountId ? { accountId: request.route.accountId } : {}),
    ...(request.route.threadId ? { threadId: request.route.threadId } : {}),
  };
}
