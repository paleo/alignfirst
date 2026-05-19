import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { Type } from "typebox";
import type { ChannelMockAccountHelpers } from "./accounts.js";
import {
  buildQaTarget,
  createQaBusThread,
  deleteQaBusMessage,
  editQaBusMessage,
  parseQaTarget,
  reactToQaBusMessage,
  readQaBusMessage,
  searchQaBusMessages,
  sendQaBusMessage,
} from "./bus-client.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

export type ChannelSurface = "discord" | "slack";

function listActions(params: {
  surface: ChannelSurface;
  helpers: ChannelMockAccountHelpers;
  cfg: CoreConfig;
  accountId?: string | null;
}): ChannelMessageActionName[] {
  const { surface, helpers, cfg, accountId } = params;
  // No enabled/configured gate here: this list drives tool-schema discovery,
  // which the SDK invokes with an empty cfg before the runtime config is
  // merged in. Hiding actions there leaves the agent with only the SDK's
  // hardcoded `send` fallback.
  const account = helpers.resolveAccount({ cfg, accountId });
  const isSlack = surface === "slack";
  const actions = new Set<ChannelMessageActionName>();
  if (!isSlack) {
    actions.add("send");
  }
  if (account.config.actions?.messages !== false) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }
  if (account.config.actions?.reactions !== false) {
    actions.add("react");
    actions.add("reactions");
  }
  if (!isSlack && account.config.actions?.threads !== false) {
    actions.add("thread-create");
    actions.add("thread-reply");
  }
  if (account.config.actions?.search !== false) {
    actions.add("search");
  }
  return Array.from(actions);
}

function readSendText(params: Record<string, unknown>) {
  return (
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true })
  );
}

// Canonical destination fallback — `to` first, then `target`, then legacy `channelId`.
function resolveDestination(params: Record<string, unknown>): string | undefined {
  const explicitTo = readStringParam(params, "to");
  if (explicitTo) {
    return explicitTo;
  }
  const target = readStringParam(params, "target");
  if (target) {
    if (/^(dm|channel|group):|^thread:[^/]+\/.+/i.test(target)) {
      return target;
    }
    return buildQaTarget({ chatType: "channel", conversationId: target });
  }
  const channelId = readStringParam(params, "channelId");
  if (channelId) {
    return buildQaTarget({ chatType: "channel", conversationId: channelId });
  }
  return undefined;
}

const SLACK_DISABLED_ACTIONS = new Set([
  "send",
  "sendMessage",
  "thread-create",
  "thread-reply",
  "threadReply",
]);

export function createChannelMockMessageActions(params: {
  channelId: string;
  surface: ChannelSurface;
  helpers: ChannelMockAccountHelpers;
}): ChannelMessageActionAdapter {
  const { surface, helpers, channelId } = params;

  return {
    describeMessageTool: (context) => ({
      actions: listActions({
        surface,
        helpers,
        cfg: context.cfg as CoreConfig,
        accountId: context.accountId,
      }),
      capabilities: [],
      schema: {
        properties: {
          to: Type.Optional(Type.String()),
          target: Type.Optional(Type.String()),
          channelId: Type.Optional(Type.String()),
          threadId: Type.Optional(Type.String()),
          messageId: Type.Optional(Type.String()),
          emoji: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
          content: Type.Optional(Type.String()),
          replyTo: Type.Optional(Type.String()),
          replyToId: Type.Optional(Type.String()),
        },
      },
    }),
    extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action === "send") {
        const to = resolveDestination(args);
        const threadId = readStringParam(args, "threadId");
        return to ? { to, threadId } : null;
      }
      if (action === "sendMessage") {
        return extractToolSend(args, "sendMessage") ?? null;
      }
      if (action === "threadReply") {
        const destination = resolveDestination(args);
        const threadId = readStringParam(args, "threadId");
        if (!destination || !threadId) {
          return null;
        }
        const { conversationId } = parseQaTarget(destination);
        return { to: `thread:${conversationId}/${threadId}` };
      }
      return null;
    },
    handleAction: async (context) => {
      const { action, cfg, accountId, params: actionParams } = context;
      if (surface === "slack" && SLACK_DISABLED_ACTIONS.has(action)) {
        throw new Error(`${channelId} slack surface does not expose action "${action}"`);
      }
      const account = helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId });
      const baseUrl = account.baseUrl;

      switch (action) {
        case "send": {
          const to = resolveDestination(actionParams);
          const text = readSendText(actionParams);
          if (!to || text === undefined) {
            throw new Error(
              `${channelId} send requires a destination (to/target/channelId) and message/text`,
            );
          }
          const parsed = parseQaTarget(to);
          const threadId = readStringParam(actionParams, "threadId") ?? parsed.threadId;
          const { message } = await sendQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            to: buildQaTarget({
              chatType: parsed.chatType,
              conversationId: parsed.conversationId,
              threadId,
            }),
            text,
            senderId: account.botUserId,
            senderName: account.botDisplayName,
            threadId,
            replyToId:
              readStringParam(actionParams, "replyTo") ??
              readStringParam(actionParams, "replyToId"),
          });
          return jsonResult({ message });
        }
        case "thread-create": {
          const destination = resolveDestination(actionParams);
          if (!destination) {
            throw new Error(
              `${channelId} thread-create requires a destination (to/target/channelId)`,
            );
          }
          const { conversationId } = parseQaTarget(destination);
          const title = readStringParam(actionParams, "title") ?? "QA thread";
          const { thread } = await createQaBusThread({
            baseUrl,
            accountId: account.accountId,
            conversationId,
            title,
            createdBy: account.botUserId,
          });
          const body = readSendText(actionParams);
          const target = `thread:${conversationId}/${thread.id}`;
          if (body !== undefined && body.trim() !== "") {
            const { message } = await sendQaBusMessage({
              baseUrl,
              accountId: account.accountId,
              to: target,
              text: body,
              senderId: account.botUserId,
              senderName: account.botDisplayName,
              threadId: thread.id,
            });
            return jsonResult({ thread, threadId: thread.id, target, message });
          }
          return jsonResult({ thread, threadId: thread.id, target });
        }
        case "thread-reply": {
          const destination = resolveDestination(actionParams);
          const threadId = readStringParam(actionParams, "threadId");
          const text = readSendText(actionParams);
          if (!destination) {
            throw new Error(
              `${channelId} thread-reply requires a destination (to/target/channelId)`,
            );
          }
          if (!threadId) {
            throw new Error(`${channelId} thread-reply requires threadId`);
          }
          if (text === undefined) {
            throw new Error(`${channelId} thread-reply requires text/message`);
          }
          const { conversationId } = parseQaTarget(destination);
          const { message } = await sendQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            to: `thread:${conversationId}/${threadId}`,
            text,
            senderId: account.botUserId,
            senderName: account.botDisplayName,
            threadId,
          });
          return jsonResult({ message });
        }
        case "react": {
          const messageId = readStringParam(actionParams, "messageId");
          const emoji = readStringParam(actionParams, "emoji");
          if (!messageId || !emoji) {
            throw new Error(`${channelId} react requires messageId and emoji`);
          }
          const { message } = await reactToQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            messageId,
            emoji,
            senderId: account.botUserId,
          });
          return jsonResult({ message });
        }
        case "reactions":
        case "read": {
          const messageId = readStringParam(actionParams, "messageId");
          if (!messageId) {
            throw new Error(`${channelId} ${action} requires messageId`);
          }
          const { message } = await readQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            messageId,
          });
          return jsonResult({ message });
        }
        case "edit": {
          const messageId = readStringParam(actionParams, "messageId");
          const text = readStringParam(actionParams, "text");
          if (!messageId || !text) {
            throw new Error(`${channelId} edit requires messageId and text`);
          }
          const { message } = await editQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            messageId,
            text,
          });
          return jsonResult({ message });
        }
        case "delete": {
          const messageId = readStringParam(actionParams, "messageId");
          if (!messageId) {
            throw new Error(`${channelId} delete requires messageId`);
          }
          const { message } = await deleteQaBusMessage({
            baseUrl,
            accountId: account.accountId,
            messageId,
          });
          return jsonResult({ message });
        }
        case "search": {
          const query = readStringParam(actionParams, "query");
          const destination = resolveDestination(actionParams);
          const conversationId = destination
            ? parseQaTarget(destination).conversationId
            : undefined;
          const threadId = readStringParam(actionParams, "threadId");
          const { messages } = await searchQaBusMessages({
            baseUrl,
            input: {
              accountId: account.accountId,
              query,
              conversationId,
              threadId,
            },
          });
          return jsonResult({ messages });
        }
        default:
          throw new Error(`${channelId} action not implemented: ${action}`);
      }
    },
  };
}
