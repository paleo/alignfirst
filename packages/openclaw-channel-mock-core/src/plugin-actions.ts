import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
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
  renameQaBusThread,
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
  actions.add("send");
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
    readStringParam(params, "message", { allowEmpty: true, trim: false }) ??
    readStringParam(params, "text", { allowEmpty: true, trim: false }) ??
    readStringParam(params, "content", { allowEmpty: true, trim: false })
  );
}

export interface HistoryScope {
  conversationId?: string;
  threadId?: string;
}

// Agents scope `read`/`search` with whatever id shape the surface handed them: the
// envelope's composite `thread:<conv>/<tid>` chat_id in `threadId`, a bare thread id
// from topic_id, a thread-shaped to/target, or nothing at all — on Discord, `read`
// without a destination reads the current channel, which in a thread session is the
// thread itself. Resolve them all to the bus's conversation/thread scope; a bare id
// that names a thread is rescoped bus-side.
export function resolveHistoryScope(
  params: Record<string, unknown>,
  currentChannelId?: string,
): HistoryScope {
  const fromThreadParam = parseScopeShape(readStringParam(params, "threadId"), {
    bareIsThread: true,
  });
  const destination = resolveDestination(params);
  const fromDestination = parseScopeShape(destination, { bareIsThread: false });
  const scope = {
    conversationId: fromDestination.conversationId ?? fromThreadParam.conversationId,
    threadId: fromThreadParam.threadId ?? fromDestination.threadId,
  };
  if (scope.conversationId !== undefined || scope.threadId !== undefined) return scope;
  return parseScopeShape(currentChannelId, { bareIsThread: false });
}

function parseScopeShape(
  raw: string | undefined,
  options: { bareIsThread: boolean },
): HistoryScope {
  if (raw === undefined) return {};
  if (/^(dm|channel|group|thread):/i.test(raw)) {
    try {
      const parsed = parseQaTarget(raw);
      return { conversationId: parsed.conversationId, threadId: parsed.threadId };
    } catch {
      return {};
    }
  }
  return options.bareIsThread ? { threadId: raw } : { conversationId: raw };
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
          threadName: Type.Optional(Type.String()),
          messageId: Type.Optional(Type.String()),
          emoji: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
          content: Type.Optional(Type.String()),
          replyTo: Type.Optional(Type.String()),
          replyToId: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer()),
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
      const { action, cfg, accountId, params: actionParams, toolContext } = context;
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
          const threadRename = await applyThreadRename({
            baseUrl,
            accountId: account.accountId,
            threadId,
            actionParams,
          });
          if (surface === "slack") {
            return jsonResult({
              ok: true,
              result: {
                messageId: message.id,
                channelId: parsed.conversationId,
                ...(threadId ? { threadTs: threadId } : {}),
              },
              ...threadRename,
            });
          }
          return jsonResult({ message, ...threadRename });
        }
        case "thread-create": {
          const destination = resolveDestination(actionParams);
          if (!destination) {
            throw new Error(
              `${channelId} thread-create requires a destination (to/target/channelId)`,
            );
          }
          const { conversationId } = parseQaTarget(destination);
          // Real Discord names a new thread with `threadName` (required there);
          // `title` stays accepted for scenarios that predate the alias.
          const title =
            readStringParam(actionParams, "threadName") ??
            readStringParam(actionParams, "title") ??
            "Test thread";
          const { thread } = await createQaBusThread({
            baseUrl,
            accountId: account.accountId,
            conversationId,
            title,
            createdBy: account.botUserId,
            parentMessageId: readStringParam(actionParams, "messageId"),
          });
          const body = readSendText(actionParams);
          const target = `thread:${conversationId}/${thread.id}`;
          if (body !== undefined && body.trim() !== "") {
            try {
              await sendQaBusMessage({
                baseUrl,
                accountId: account.accountId,
                to: target,
                text: body,
                senderId: account.botUserId,
                senderName: account.botDisplayName,
                threadId: thread.id,
              });
            } catch (error) {
              return jsonResult({
                ok: true,
                partial: true,
                thread,
                warning: "Discord thread was created, but its initial message was not delivered.",
                initialMessageError: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return jsonResult({ ok: true, thread });
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
          const threadRename = await applyThreadRename({
            baseUrl,
            accountId: account.accountId,
            threadId,
            actionParams,
          });
          return jsonResult({ message, ...threadRename });
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
        case "reactions": {
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
        case "read": {
          // Bulk read prior messages. Real Discord lists a channel's messages
          // (a thread is a channel) via `channelId ?? to ?? currentChannelId`;
          // real Slack requires channelId/to and honors threadId as a filter.
          // Unlike real Discord we also honor the threadId param — the message
          // tool's thread-read hint endorses it, and in a thread session the
          // real currentChannelId fallback lands on the same messages. Single-
          // message fetch lives under `reactions`.
          if (surface === "slack" && resolveDestination(actionParams) === undefined) {
            throw new Error(`${channelId} read requires a destination (to/channelId)`);
          }
          const { conversationId, threadId } = resolveHistoryScope(
            actionParams,
            toolContext?.currentChannelId,
          );
          if (conversationId === undefined && threadId === undefined) {
            throw new Error(
              `${channelId} read requires threadId or a destination (to/target/channelId)`,
            );
          }
          const limit = readNumberParam(actionParams, "limit", { integer: true });
          const { messages } = await searchQaBusMessages({
            baseUrl,
            input: {
              accountId: account.accountId,
              conversationId,
              threadId,
              limit,
            },
          });
          return jsonResult({ messages });
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
          const { conversationId, threadId } = resolveHistoryScope(
            actionParams,
            toolContext?.currentChannelId,
          );
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

/**
 * Real Discord has no rename-only action: an existing thread is renamed by a
 * `threadName` param riding on the send that posts into it
 * (`extensions/discord/src/actions/runtime.messaging.send.ts`). Mirror that,
 * warning rather than throwing when the target isn't a thread — as Discord does.
 */
async function applyThreadRename(params: {
  baseUrl: string;
  accountId: string;
  threadId: string | undefined;
  actionParams: Record<string, unknown>;
}): Promise<
  { threadRename?: { ok: true; threadId: string; title: string } } | { warning: string }
> {
  const title = readStringParam(params.actionParams, "threadName");
  if (!title) return {};
  if (!params.threadId) {
    return { warning: "threadName was ignored because the send target is not a thread." };
  }
  const { thread } = await renameQaBusThread({
    baseUrl: params.baseUrl,
    accountId: params.accountId,
    threadId: params.threadId,
    title,
  });
  return { threadRename: { ok: true, threadId: thread.id, title: thread.title } };
}
