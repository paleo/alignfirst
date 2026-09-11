import { describe, expect, it } from "vitest";
import { buildLastRoute, buildTurnContext } from "../src/thread-handoff/dispatch.js";
import type { TurnRequest } from "../src/thread-handoff/types.js";

describe("thread-handoff reply dispatch", () => {
  it("builds a senderless Slack thread context and last route", () => {
    const request = slackRequest();
    const before = Date.now();
    const context = buildTurnContext(request);
    const after = Date.now();

    expect(context).toEqual({
      Body: "Wake the thread.",
      BodyForAgent: "Wake the thread.",
      RawBody: "Wake the thread.",
      CommandBody: "",
      CommandInterpretationSuppressed: true,
      CommandAuthorized: false,
      SessionKey: request.sessionKey,
      AccountId: "workspace-1",
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      From: "channel:C1",
      To: "channel:C1",
      OriginatingTo: "channel:C1",
      NativeChannelId: "C1",
      ChatType: "group",
      GroupChannel: "C1",
      ConversationLabel: "C1",
      GroupSubject: "C1",
      MessageThreadId: "100.200",
      ThreadParentId: "C1",
      WasMentioned: false,
      SenderName: "AlignFirst Service",
      MessageSid: "message-1",
      MessageSidFull: "message-1",
      Timestamp: expect.any(Number),
    });
    expect(context.Timestamp).toEqual(expect.any(Number));
    expect(context.Timestamp as number).toBeGreaterThanOrEqual(before);
    expect(context.Timestamp as number).toBeLessThanOrEqual(after);
    expect(context).not.toHaveProperty("SenderId");
    expect(buildLastRoute(request)).toEqual({
      sessionKey: request.sessionKey,
      channel: "slack",
      to: "channel:C1",
      accountId: "workspace-1",
      threadId: "100.200",
    });
  });

  it("builds a Discord thread context and last route", () => {
    const request: TurnRequest = {
      sessionKey: "agent:main:discord:channel:T1",
      agentId: "main",
      channelId: "discord",
      surface: "discord",
      route: { channel: "discord", to: "channel:T1" },
      parentConversationId: "C1",
      message: "Wake the thread.",
      messageId: "message-2",
    };

    expect(buildTurnContext(request)).toMatchObject({
      AccountId: undefined,
      NativeChannelId: "T1",
      GroupChannel: "C1",
      ConversationLabel: "C1",
      GroupSubject: "C1",
      MessageThreadId: "T1",
      ThreadParentId: "C1",
    });
    expect(buildLastRoute(request)).toEqual({
      sessionKey: request.sessionKey,
      channel: "discord",
      to: "channel:T1",
    });
  });

  it("falls back to the Discord thread id when its parent is unknown", () => {
    const request: TurnRequest = {
      sessionKey: "agent:main:discord:channel:T1",
      agentId: "main",
      channelId: "discord",
      surface: "discord",
      route: { channel: "discord", to: "channel:T1" },
      message: "Wake the thread.",
      messageId: "message-3",
    };
    const context = buildTurnContext(request);

    expect(context).toMatchObject({
      NativeChannelId: "T1",
      GroupChannel: "T1",
      ConversationLabel: "T1",
      GroupSubject: "T1",
      MessageThreadId: "T1",
    });
    expect(context).not.toHaveProperty("ThreadParentId");
  });
});

function slackRequest(): TurnRequest {
  return {
    sessionKey: "agent:main:slack:channel:C1:thread:100.200",
    agentId: "main",
    channelId: "slack",
    surface: "slack",
    route: {
      channel: "slack",
      to: "channel:C1",
      accountId: "workspace-1",
      threadId: "100.200",
    },
    parentConversationId: "C1",
    message: "Wake the thread.",
    messageId: "message-1",
  };
}
