import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { buildLastRoute, buildTurnContext, dispatchTurn } from "../src/thread-handoff/dispatch.js";
import type { TurnRequest } from "../src/thread-handoff/types.js";

describe("thread-handoff reply dispatch", () => {
  it("disables block streaming so the durable adapter receives the final payload", async () => {
    const dispatchReply = vi.fn(async () => undefined);
    const runtime = {
      config: { current: () => ({}) },
      channel: {
        inbound: { dispatchReply },
        reply: {
          finalizeInboundContext: (context: Record<string, unknown>) => context,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        session: {
          resolveStorePath: () => "/state/main/sessions.json",
          recordInboundSession: vi.fn(),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"];
    const logger = { warn: vi.fn() } as unknown as PluginLogger;

    await dispatchTurn({ runtime, logger, request: slackRequest() });

    expect(dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: { disableBlockStreaming: true },
        delivery: expect.objectContaining({
          durable: { to: "channel:C1", threadId: "100.200", replyToId: null },
        }),
      }),
    );
  });

  it("builds an unauthorized Slack thread context and last route", () => {
    const request = slackRequest();

    expect(buildTurnContext(request)).toMatchObject({
      CommandInterpretationSuppressed: true,
      CommandAuthorized: false,
      MessageThreadId: "100.200",
      ThreadParentId: "C1",
    });
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
      message: "Take over this thread.",
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
    message: "Take over this thread.",
    messageId: "message-1",
  };
}
