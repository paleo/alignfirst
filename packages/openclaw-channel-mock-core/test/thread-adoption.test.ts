import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelMockAccountHelpers } from "../src/accounts.js";
import {
  type ActiveTurnThreadRoute,
  beginActiveTurnThreadRoute,
} from "../src/active-turn-thread-route.js";
import { createBus } from "../src/bus-handler.js";
import { buildDeliveryCallback } from "../src/inbound.js";
import { createChannelMockMessageActions } from "../src/plugin-actions.js";
import type { QaBusMessage } from "../src/protocol.js";
import type { CoreConfig } from "../src/types.js";

const CHANNEL_ID = "discord-mock";
const SESSION_KEY = "agent:main:discord-mock:channel:project-x";

type Fixture = {
  server: Server;
  baseUrl: string;
  bus: ReturnType<typeof createBus>;
  cfg: CoreConfig;
};

describe("Discord thread adoption", () => {
  let fixture: Fixture;
  let endRoute: (() => void) | undefined;
  beforeEach(async () => {
    fixture = await start();
  });
  afterEach(async () => {
    endRoute?.();
    endRoute = undefined;
    await stop(fixture);
  });

  it("moves the turn's final reply into a thread anchored on its message", async () => {
    const inbound = injectRoot(fixture);
    const route = beginRoute(inbound);
    const created = await act(fixture, "thread-create", {
      to: "channel:project-x",
      threadName: "Work",
      messageId: inbound.id,
    });
    const threadId = readThreadId(created);
    expect(route.adoptedThread).toEqual({ conversationId: "project-x", threadId });

    const reply = await act(fixture, "thread-reply", { threadId, message: "Starter" });
    expect(reply).toMatchObject({
      ok: true,
      result: { channelId: threadId },
      sourceReplyRoute: "current-source",
    });
    await deliver(fixture, inbound, route, "Final reply");
    const outbound = outboundMessages(fixture);
    expect(outbound.map((message) => [message.text, message.threadId])).toEqual([
      ["Starter", threadId],
      ["Final reply", threadId],
    ]);
    expect(outbound[1]?.replyToId).toBeUndefined();
  });

  it("leaves a thread anchored elsewhere unadopted", async () => {
    const inbound = injectRoot(fixture);
    const route = beginRoute(inbound);
    const created = await act(fixture, "thread-create", {
      to: "channel:project-x",
      threadName: "Work",
      messageId: "another-message",
    });
    const threadId = readThreadId(created);
    expect(route.adoptedThread).toBeUndefined();

    const reply = await act(fixture, "thread-reply", { threadId, message: "Starter" });
    expect(reply).not.toHaveProperty("sourceReplyRoute");
    await deliver(fixture, inbound, route, "Final reply");
    expect(outboundMessages(fixture).at(-1)).toMatchObject({
      text: "Final reply",
      threadId: undefined,
      replyToId: inbound.id,
    });
  });

  it("tags no reply from another session", async () => {
    const inbound = injectRoot(fixture);
    beginRoute(inbound);
    const threadId = readThreadId(
      await act(fixture, "thread-create", {
        to: "channel:project-x",
        threadName: "Work",
        messageId: inbound.id,
      }),
    );
    const reply = await act(
      fixture,
      "thread-reply",
      { threadId, message: "Starter" },
      "agent:main:discord-mock:channel:other",
    );
    expect(reply).not.toHaveProperty("sourceReplyRoute");
  });

  function beginRoute(inbound: QaBusMessage): ActiveTurnThreadRoute {
    const route: ActiveTurnThreadRoute = {
      accountId: CHANNEL_ID,
      sourceChannelId: inbound.conversation.id,
      sourceMessageId: inbound.id,
    };
    endRoute = beginActiveTurnThreadRoute(SESSION_KEY, route);
    return route;
  }
});

function injectRoot(fixture: Fixture): QaBusMessage {
  return fixture.bus.state.addInboundMessage({
    accountId: CHANNEL_ID,
    conversation: { kind: "channel", id: "project-x" },
    senderId: "user-a",
    text: "Start the work.",
  });
}

async function act(
  fixture: Fixture,
  action: string,
  params: Record<string, unknown>,
  sessionKey = SESSION_KEY,
): Promise<Record<string, unknown>> {
  const actions = createChannelMockMessageActions({
    channelId: CHANNEL_ID,
    surface: "discord",
    helpers: createChannelMockAccountHelpers({ channelId: CHANNEL_ID }),
  });
  const handleAction = actions.handleAction as unknown as (
    context: Record<string, unknown>,
  ) => Promise<{ details: Record<string, unknown> }>;
  const result = await handleAction({
    action,
    cfg: fixture.cfg,
    accountId: CHANNEL_ID,
    params,
    sessionKey,
  });
  return result.details;
}

function readThreadId(details: Record<string, unknown>): string {
  const thread = details.thread as { id?: unknown } | undefined;
  if (typeof thread?.id !== "string") throw new Error("thread-create returned no thread");
  return thread.id;
}

async function deliver(
  fixture: Fixture,
  inbound: QaBusMessage,
  threadRoute: ActiveTurnThreadRoute,
  text: string,
) {
  const helpers = createChannelMockAccountHelpers({ channelId: CHANNEL_ID });
  const callback = buildDeliveryCallback({
    account: helpers.resolveAccount({ cfg: fixture.cfg, accountId: CHANNEL_ID }),
    inbound,
    target: "channel:project-x",
    toolCalls: [],
    threadRoute,
  });
  await callback({ text });
}

function outboundMessages(fixture: Fixture) {
  return fixture.bus.state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound");
}

async function start(): Promise<Fixture> {
  const bus = createBus();
  const server = createServer(async (req, res) => {
    const handled = await bus.handler(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cfg = {
    channels: { [CHANNEL_ID]: { baseUrl, botUserId: "openclaw", allowFrom: ["*"] } },
  } as CoreConfig;
  return { server, baseUrl, bus, cfg };
}

async function stop(fixture: Fixture) {
  await new Promise<void>((resolve, reject) => {
    fixture.server.close((error) => (error ? reject(error) : resolve()));
    fixture.server.closeAllConnections?.();
  });
}
