import { describe, expect, it } from "vitest";
import { resolveHistoryScope } from "../src/plugin-actions.js";
import { createChannelMockAccountHelpers } from "../src/accounts.js";
import { buildInboundEnvelopeTarget, resolveInboundSessionKey } from "../src/inbound.js";

describe("resolveHistoryScope", () => {
  it.each<{
    name: string;
    params: Record<string, unknown>;
    current?: string;
    expected: { conversationId?: string; threadId?: string };
  }>([
    {
      name: "parses a composite thread target passed as threadId",
      params: { threadId: "thread:conv-1/conv-1-thread-abc", limit: 50 },
      expected: { conversationId: "conv-1", threadId: "conv-1-thread-abc" },
    },
    {
      name: "keeps a bare threadId as the thread filter",
      params: { threadId: "conv-1-thread-abc" },
      expected: { threadId: "conv-1-thread-abc" },
    },
    {
      name: "takes the thread id carried by a thread-shaped destination",
      params: { to: "thread:conv-1/conv-1-thread-abc" },
      expected: { conversationId: "conv-1", threadId: "conv-1-thread-abc" },
    },
    {
      name: "combines a channel destination with a bare threadId",
      params: { channelId: "conv-1", threadId: "conv-1-thread-abc" },
      expected: { conversationId: "conv-1", threadId: "conv-1-thread-abc" },
    },
    {
      name: "treats a channel-prefixed threadId as a conversation scope",
      params: { threadId: "channel:conv-1-thread-abc" },
      expected: { conversationId: "conv-1-thread-abc" },
    },
    {
      name: "falls back to the current thread when no scope params are given",
      params: { limit: 20 },
      current: "thread:conv-1/conv-1-thread-abc",
      expected: { conversationId: "conv-1", threadId: "conv-1-thread-abc" },
    },
    {
      name: "falls back to the current channel when no scope params are given",
      params: {},
      current: "conv-1",
      expected: { conversationId: "conv-1" },
    },
    {
      name: "ignores the current channel when params already scope the read",
      params: { threadId: "t-1" },
      current: "channel:other",
      expected: { threadId: "t-1" },
    },
    { name: "resolves to an empty scope when nothing is given", params: {}, expected: {} },
  ])("$name", ({ params, current, expected }) => {
    expect(resolveHistoryScope(params, current)).toEqual(expected);
  });
});

describe("Slack session routing", () => {
  it("keeps off-mode roots on the account-qualified channel session", () => {
    expect(
      resolveInboundSessionKey({
        surface: "slack",
        channelId: "slack-mock",
        route: {
          agentId: "main",
          sessionKey: "agent:main:slack-mock:account:Team-A:channel:Project-X",
        },
        threadId: undefined,
      }),
    ).toBe("agent:main:slack-mock:account:Team-A:channel:Project-X");
  });

  it("derives an all-mode thread session from the account-qualified channel session", () => {
    expect(
      resolveInboundSessionKey({
        surface: "slack",
        channelId: "slack-mock",
        route: {
          agentId: "main",
          sessionKey: "agent:main:slack-mock:account:Team-A:channel:Project-X",
        },
        threadId: "Root-Message-ID",
      }),
    ).toBe("agent:main:slack-mock:account:Team-A:channel:Project-X:thread:root-message-id");
  });

  it("inherits replyToMode and permits an account override", () => {
    const helpers = createChannelMockAccountHelpers({ channelId: "slack-mock" });
    const cfg = {
      channels: {
        "slack-mock": {
          baseUrl: "http://bus",
          replyToMode: "all" as const,
          accounts: {
            "Team-A": { baseUrl: "http://a", replyToMode: "off" as const },
            "Team-B": { baseUrl: "http://b" },
          },
        },
      },
    };
    expect(helpers.resolveAccount({ cfg, accountId: "Team-A" }).config.replyToMode).toBe("off");
    expect(helpers.resolveAccount({ cfg, accountId: "Team-B" }).config.replyToMode).toBe("all");
  });
});

describe("inbound envelope targets", () => {
  it.each([
    { surface: "discord", expected: "channel:thread-channel" },
    { surface: "slack", expected: "thread:parent-channel/thread-channel" },
  ] as const)("addresses a $surface thread as $expected", ({ surface, expected }) => {
    expect(
      buildInboundEnvelopeTarget({
        surface,
        chatType: "channel",
        conversationId: "parent-channel",
        threadId: "thread-channel",
      }),
    ).toBe(expected);
  });
});
