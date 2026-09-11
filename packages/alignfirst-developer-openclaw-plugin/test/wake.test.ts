import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandoffStore, type HandoffStore } from "../src/thread-handoff/state.js";
import { registerWakeMethod, resolveWakeTarget } from "../src/thread-handoff/wake.js";
import { handoff, temporaryStateDir } from "./helpers.js";

const sessionStore = vi.hoisted(() => ({ getSessionEntry: vi.fn() }));
const dispatchTurn = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return { ...actual, getSessionEntry: sessionStore.getSessionEntry };
});

vi.mock("../src/thread-handoff/dispatch.js", () => ({ dispatchTurn }));

describe("thread-handoff wake target", () => {
  beforeEach(() => {
    sessionStore.getSessionEntry.mockReset();
    dispatchTurn.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    {
      name: "Slack channel session",
      sessionKey: "agent:main:slack:channel:C1",
      route: { channel: "slack", to: "channel:C1", threadId: "100.200" },
      message: "Slack thread wake requires a thread session.",
    },
    {
      name: "direct session",
      sessionKey: "agent:main:slack:direct:U1",
      route: { channel: "slack", to: "dm:U1", threadId: "100.200" },
      message: "Thread wake requires a channel-thread session.",
    },
    {
      name: "subagent session",
      sessionKey: "agent:main:subagent:00000000-0000-4000-8000-000000000000",
      message: "Thread wake requires a regular channel-thread session.",
    },
    {
      name: "unconfigured channel",
      sessionKey: "agent:main:teams:channel:C1",
      route: { channel: "teams", to: "channel:C1" },
      message: "Channel teams is not configured for handoff.",
    },
  ])("refuses a $name", async ({ sessionKey, route, message }) => {
    sessionStore.getSessionEntry.mockReturnValue(route ? sessionEntry(route) : undefined);
    const fixture = wakeFixture();

    await expect(
      resolveWakeTarget({
        sessionKey,
        message: "Wake.",
        configuration: fixture.configuration,
        getStore: () => fixture.store,
        runtime: fixture.runtime,
      }),
    ).rejects.toThrow(message);
    fixture.store.close();
  });

  it("refuses a session without a persisted route", async () => {
    const fixture = wakeFixture();

    await expect(
      resolveWakeTarget({
        sessionKey: "agent:main:discord:channel:T1",
        message: "Wake.",
        configuration: fixture.configuration,
        getStore: () => fixture.store,
        runtime: fixture.runtime,
      }),
    ).rejects.toThrow("No delivery route is recorded for this session.");
    fixture.store.close();
  });

  it("prefers the session route and accepts a Discord channel-shaped key", async () => {
    const fixture = wakeFixture();
    fixture.store.insertHandoff(
      handoff({
        targetSessionKey: "agent:main:discord:channel:T1",
        channelId: "discord",
        deliveryContext: { channel: "discord", to: "channel:record-route" },
      }),
    );
    sessionStore.getSessionEntry.mockReturnValue(
      sessionEntry({ channel: "discord", to: "channel:T1", accountId: "discord-account" }),
    );

    await expect(
      resolveWakeTarget({
        sessionKey: "agent:main:discord:channel:T1",
        message: "Wake.",
        configuration: fixture.configuration,
        getStore: () => fixture.store,
        runtime: fixture.runtime,
      }),
    ).resolves.toMatchObject({
      sessionKey: "agent:main:discord:channel:T1",
      agentId: "main",
      channelId: "discord",
      surface: "discord",
      route: { channel: "discord", to: "channel:T1", accountId: "discord-account" },
      parentConversationId: "C1",
      message: "Wake.",
      messageId: expect.stringMatching(/^thread-handoff:wake:[0-9a-f-]{36}$/u),
    });
    fixture.store.close();
  });

  it("falls back to the handoff route and parent conversation", async () => {
    const fixture = wakeFixture();
    const record = handoff();
    fixture.store.insertHandoff(record);

    await expect(
      resolveWakeTarget({
        sessionKey: record.targetSessionKey,
        message: "Wake.",
        configuration: fixture.configuration,
        getStore: () => fixture.store,
        runtime: fixture.runtime,
      }),
    ).resolves.toMatchObject({
      route: record.deliveryContext,
      parentConversationId: "C1",
      messageId: expect.stringMatching(/^thread-handoff:wake:[0-9a-f-]{36}$/u),
    });
    fixture.store.close();
  });
});

describe("thread-handoff wake gateway method", () => {
  beforeEach(() => {
    sessionStore.getSessionEntry.mockReset();
    dispatchTurn.mockReset().mockResolvedValue(undefined);
  });

  it("responds with INVALID_REQUEST when the target is refused", async () => {
    sessionStore.getSessionEntry.mockReturnValue(
      sessionEntry({ channel: "slack", to: "channel:C1", threadId: "100.200" }),
    );
    const fixture = wakeFixture();
    const { handler } = registerHandler(fixture);
    const respond = vi.fn();

    await handler({
      params: { sessionKey: "agent:main:slack:channel:C1", message: "Wake." },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Slack thread wake requires a thread session."),
      }),
    );
    fixture.store.close();
  });

  it("returns completed after a fulfilled dispatch", async () => {
    sessionStore.getSessionEntry.mockReturnValue(
      sessionEntry({ channel: "discord", to: "channel:T1" }),
    );
    const fixture = wakeFixture();
    const { handler } = registerHandler(fixture);
    const respond = vi.fn();

    await handler({
      params: { sessionKey: "agent:main:discord:channel:T1", message: "Wake." },
      respond,
    });

    expect(dispatchTurn).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { status: "completed" });
    fixture.store.close();
  });

  it("returns a failed result after a rejected dispatch", async () => {
    sessionStore.getSessionEntry.mockReturnValue(
      sessionEntry({ channel: "discord", to: "channel:T1" }),
    );
    dispatchTurn.mockRejectedValueOnce(new Error("dispatch failed"));
    const fixture = wakeFixture();
    const { handler } = registerHandler(fixture);
    const respond = vi.fn();

    await handler({
      params: { sessionKey: "agent:main:discord:channel:T1", message: "Wake." },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(true, {
      status: "failed",
      error: "dispatch failed",
    });
    fixture.store.close();
  });
});

interface TestGatewayRequest {
  params: Record<string, unknown>;
  respond: (...args: unknown[]) => void;
}

interface WakeFixture {
  configuration: { channelSurfaces: { slack: "slack"; discord: "discord" } };
  store: HandoffStore;
  runtime: OpenClawPluginApi["runtime"];
  logger: PluginLogger;
}

function wakeFixture(): WakeFixture {
  const store = createHandoffStore(temporaryStateDir());
  const runtime = {
    config: { current: () => ({}) },
    channel: { session: { resolveStorePath: vi.fn(() => "/state/main/sessions.json") } },
  } as unknown as OpenClawPluginApi["runtime"];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as PluginLogger;
  return {
    configuration: { channelSurfaces: { slack: "slack", discord: "discord" } },
    store,
    runtime,
    logger,
  };
}

function registerHandler(fixture: WakeFixture): {
  handler: (request: TestGatewayRequest) => Promise<void> | void;
} {
  const registerGatewayMethod = vi.fn();
  const api = {
    runtime: fixture.runtime,
    registerGatewayMethod,
  } as unknown as OpenClawPluginApi;
  registerWakeMethod(api, {
    configuration: fixture.configuration,
    getStore: () => fixture.store,
    logger: fixture.logger,
  });
  expect(registerGatewayMethod).toHaveBeenCalledWith(
    "alignfirst-developer.wake",
    expect.any(Function),
    { scope: "operator.write" },
  );
  const handler = registerGatewayMethod.mock.calls[0]?.[1];
  if (typeof handler !== "function") throw new Error("wake handler was not registered");
  return { handler };
}

function sessionEntry(context: Record<string, unknown>): Record<string, unknown> {
  return { delivery: { kind: "external", context } };
}
