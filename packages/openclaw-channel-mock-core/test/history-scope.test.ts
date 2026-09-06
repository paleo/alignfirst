import { describe, expect, it } from "vitest";
import { resolveHistoryScope } from "../src/plugin-actions.js";
import { createChannelMockAccountHelpers } from "../src/accounts.js";
import { resolveInboundSessionKey } from "../src/inbound.js";

describe("resolveHistoryScope", () => {
  it("parses a composite thread target passed as threadId (envelope chat_id shape)", () => {
    const scope = resolveHistoryScope({ threadId: "thread:conv-1/conv-1-thread-abc", limit: 50 });
    expect(scope).toEqual({ conversationId: "conv-1", threadId: "conv-1-thread-abc" });
  });

  it("keeps a bare threadId as the thread filter", () => {
    expect(resolveHistoryScope({ threadId: "conv-1-thread-abc" })).toEqual({
      threadId: "conv-1-thread-abc",
    });
  });

  it("takes the thread id carried by a thread-shaped destination", () => {
    expect(resolveHistoryScope({ to: "thread:conv-1/conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
  });

  it("combines a channel destination with a bare threadId", () => {
    expect(resolveHistoryScope({ channelId: "conv-1", threadId: "conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
  });

  it("treats a channel-prefixed threadId as a conversation scope", () => {
    expect(resolveHistoryScope({ threadId: "channel:conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1-thread-abc",
    });
  });

  it("falls back to the current channel when no scope params are given", () => {
    expect(resolveHistoryScope({ limit: 20 }, "thread:conv-1/conv-1-thread-abc")).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
    expect(resolveHistoryScope({}, "conv-1")).toEqual({ conversationId: "conv-1" });
  });

  it("ignores the current channel when params already scope the read", () => {
    expect(resolveHistoryScope({ threadId: "t-1" }, "channel:other")).toEqual({ threadId: "t-1" });
  });

  it("resolves to an empty scope when nothing is given", () => {
    expect(resolveHistoryScope({})).toEqual({});
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

  it("routes an all-mode root and its later reply to exactly the same session", () => {
    const route = {
      agentId: "main",
      sessionKey: "agent:main:slack-mock:account:Team-A:channel:Project-X",
    };
    const root = resolveInboundSessionKey({
      surface: "slack",
      channelId: "slack-mock",
      route,
      threadId: "Root-Message-ID",
    });
    const reply = resolveInboundSessionKey({
      surface: "slack",
      channelId: "slack-mock",
      route,
      threadId: "Root-Message-ID",
    });
    expect(root).toBe(reply);
    expect(root).toContain(":thread:root-message-id");
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
