import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { HandoffError } from "../src/thread-handoff/errors.js";
import {
  assertSupportedSource,
  readSourceContext,
  resolveHandoffRoute,
} from "../src/thread-handoff/routing.js";
import type { PluginConfiguration, SourceContext } from "../src/thread-handoff/types.js";

const configuration: PluginConfiguration = {
  channelSurfaces: { slack: "slack", discord: "discord" },
};

describe("handoff routing", () => {
  it("derives Slack suffix routing and retains exact delivery IDs", () => {
    const source = sourceContext();
    expect(assertSupportedSource(source, configuration)).toBe("slack");
    expect(resolveHandoffRoute(source, "171.ABC", "slack")).toMatchObject({
      targetSessionKey: "agent:main:slack:channel:C1:thread:171.abc",
      deliveryContext: {
        channel: "slack",
        to: "channel:C1",
        accountId: "workspace-1",
        threadId: "171.ABC",
      },
    });
  });

  it("builds a Discord thread as a channel route", () => {
    const source = sourceContext({
      sessionKey: "agent:main:discord:channel:Parent",
      channelId: "discord",
      parentConversationId: "Parent",
    });
    expect(resolveHandoffRoute(source, "Thread-ID", "discord")).toMatchObject({
      targetSessionKey: "agent:main:discord:channel:thread-id",
      deliveryContext: { channel: "discord", to: "channel:Thread-ID" },
    });
  });

  it.each([
    "agent:main:slack:channel:C1:thread:100.200",
    "agent:main:subagent:child",
    "agent:main:main",
  ])("rejects unsupported source session %s", (sessionKey) => {
    expect(() => assertSupportedSource(sourceContext({ sessionKey }), configuration)).toThrow(
      HandoffError,
    );
  });

  it("accepts a bare Slack exec route only when its trusted session agrees", () => {
    expect(readSourceContext(nativeCompletionContext(), configuration)).toMatchObject({
      parentConversationId: "C1",
      channelId: "slack",
      accountId: "workspace-1",
      deliveryContext: { to: "C1", threadId: "171.ABC" },
    });
    expect(
      readSourceContext(
        nativeCompletionContext({
          sessionKey: "agent:main:slack:channel:c1",
        }),
        configuration,
      ),
    ).toMatchObject({ parentConversationId: "C1" });
  });

  it.each([
    { deliveryContext: undefined },
    { deliveryContext: { channel: "slack", accountId: "workspace-1" } },
    { deliveryContext: { channel: "slack", to: "OTHER", threadId: "171.ABC" } },
    { deliveryContext: { channel: "slack", to: "C1", threadId: "other" } },
    { deliveryContext: { channel: "slack", to: "C1" } },
    { deliveryContext: { channel: "slack", to: "C1", accountId: "other", threadId: "171.ABC" } },
    { deliveryContext: { channel: "slack", to: "team:T1:channel:C1", threadId: "171.ABC" } },
    { messageChannel: "discord" },
    { agentId: "other" },
    { sessionId: undefined },
    { sessionKey: undefined },
    { sessionKey: "agent:main:discord:channel:c1:thread:171.abc" },
    { sessionKey: "agent:main:slack:direct:c1:thread:171.abc" },
    { sessionKey: "agent:main:subagent:child" },
    { sessionKey: "agent:main:cron:job" },
    { sessionKey: "agent:main:acp:child" },
  ])("rejects missing or inconsistent bare completion routing: %j", (overrides) => {
    expect(readSourceContext(nativeCompletionContext(overrides), configuration)).toBeUndefined();
  });

  it("does not broaden Discord's qualified target contract", () => {
    expect(
      readSourceContext(
        nativeCompletionContext({
          messageChannel: "discord",
          sessionKey: "agent:main:discord:channel:c1",
          deliveryContext: { channel: "discord", to: "C1" },
        }),
        configuration,
      ),
    ).toBeUndefined();
  });

  it("recovers heartbeat claim identity from the trusted delivery route", () => {
    expect(
      readSourceContext(
        {
          agentId: "main",
          sessionKey: "agent:main:slack:channel:c1:thread:171.abc",
          sessionId: "target-session",
          deliveryContext: {
            channel: "slack",
            to: "channel:C1",
            accountId: "workspace-1",
            threadId: "171.ABC",
          },
        },
        configuration,
      ),
    ).toMatchObject({
      channelId: "slack",
      parentConversationId: "C1",
      accountId: "workspace-1",
    });
  });
});

function nativeCompletionContext(
  overrides: Partial<OpenClawPluginToolContext> = {},
): OpenClawPluginToolContext {
  return {
    agentId: "main",
    sessionId: "target-session",
    sessionKey: "agent:main:slack:channel:c1:thread:171.abc",
    messageChannel: "slack",
    agentAccountId: "workspace-1",
    deliveryContext: {
      channel: "slack",
      to: "C1",
      accountId: "workspace-1",
      threadId: "171.ABC",
    },
    ...overrides,
  };
}

function sourceContext(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    agentId: "main",
    sessionKey: "agent:main:slack:channel:C1",
    sessionId: "session-uuid",
    channelId: "slack",
    accountId: "workspace-1",
    parentConversationId: "C1",
    ...overrides,
  };
}
