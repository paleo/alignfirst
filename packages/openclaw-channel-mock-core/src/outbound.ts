import type { ChannelMockAccountHelpers } from "./accounts.js";
import { buildQaTarget, parseQaTarget, sendQaBusMessage } from "./bus-client.js";
import type { CoreConfig } from "./types.js";

export function createSendChannelMockText(params: { helpers: ChannelMockAccountHelpers }) {
  const { helpers } = params;
  return async function sendChannelMockText(input: {
    cfg: CoreConfig;
    accountId?: string | null;
    to: string;
    text: string;
    threadId?: string | number | null;
    replyToId?: string | number | null;
  }) {
    const account = helpers.resolveAccount({ cfg: input.cfg, accountId: input.accountId });
    const parsed = parseQaTarget(input.to);
    const resolvedThreadId = input.threadId == null ? parsed.threadId : String(input.threadId);
    const { message } = await sendQaBusMessage({
      baseUrl: account.baseUrl,
      accountId: account.accountId,
      to: buildQaTarget({
        chatType: parsed.chatType,
        conversationId: parsed.conversationId,
        threadId: resolvedThreadId,
      }),
      text: input.text,
      senderId: account.botUserId,
      senderName: account.botDisplayName,
      threadId: resolvedThreadId,
      replyToId: input.replyToId == null ? undefined : String(input.replyToId),
    });
    return { to: input.to, messageId: message.id };
  };
}
