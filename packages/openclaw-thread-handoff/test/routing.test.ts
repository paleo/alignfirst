import { describe, expect, it } from "vitest";
import { HandoffError } from "../src/errors.js";
import { assertSupportedSource, readSourceContext, resolveHandoffRoute } from "../src/routing.js";
import type { PluginConfiguration, SourceContext } from "../src/types.js";

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
