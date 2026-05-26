import {
  buildDeliveryCallback,
  createBus,
  type QaBusMessage,
  type ResolvedChannelMockAccount,
} from "@paleo/openclaw-channel-mock-core";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type BusFixture = { server: Server; baseUrl: string; bus: ReturnType<typeof createBus> };

async function startBus(): Promise<BusFixture> {
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
  if (!address || typeof address === "string") throw new Error("failed to bind test bus");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, bus };
}

async function stopBus(fixture: BusFixture) {
  await new Promise<void>((resolve, reject) => {
    fixture.server.close((error) => (error ? reject(error) : resolve()));
    fixture.server.closeAllConnections?.();
  });
}

function makeAccount(baseUrl: string): ResolvedChannelMockAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl,
    botUserId: "openclaw",
    botDisplayName: "OpenClaw Test",
    pollTimeoutMs: 1000,
    config: {
      baseUrl,
      botUserId: "openclaw",
      botDisplayName: "OpenClaw Test",
      allowFrom: ["*"],
    },
  };
}

function makeInbound(opts: { threadId?: string }): QaBusMessage {
  return {
    id: "msg-in-1",
    accountId: "default",
    direction: "inbound",
    conversation: { kind: "channel", id: "sample-project", title: "sample-project" },
    threadId: opts.threadId,
    senderId: "MYUSERID1",
    senderName: "My User",
    text: "We have some work to do on sample-project.",
    timestamp: Date.now(),
    reactions: [],
  };
}

describe("slack-mock buildDeliveryCallback (autoThread=true)", () => {
  let fixture: BusFixture;
  beforeEach(async () => {
    fixture = await startBus();
  });
  afterEach(async () => {
    await stopBus(fixture);
  });

  it("bare-channel inbound auto-threads and routes both outbounds into one thread", async () => {
    const inbound = makeInbound({ threadId: undefined });
    const deliver = buildDeliveryCallback({
      account: makeAccount(fixture.baseUrl),
      inbound,
      target: "channel:sample-project",
      toolCalls: [],
      autoThread: true,
    });

    await deliver({ text: "starter announcement" });
    await deliver({ text: "follow-up question?" });

    const snap = fixture.bus.state.getSnapshot();
    expect(snap.threads.length).toBe(1);
    const threadId = snap.threads[0].id;
    const messagesInThread = snap.messages.filter((m) => m.threadId === threadId);
    expect(messagesInThread.length).toBe(2);
    expect(messagesInThread[0].replyToId).toBe(inbound.id);
    expect(messagesInThread[1].replyToId).toBe(undefined);
  });

  it("thread inbound routes outbounds back into the existing thread", async () => {
    const inbound = makeInbound({ threadId: "T-existing" });
    const deliver = buildDeliveryCallback({
      account: makeAccount(fixture.baseUrl),
      inbound,
      target: "thread:sample-project/T-existing",
      toolCalls: [],
      autoThread: true,
    });

    await deliver({ text: "thread reply" });

    const snap = fixture.bus.state.getSnapshot();
    expect(snap.threads.length).toBe(0);
    expect(snap.messages.length).toBe(1);
    expect(snap.messages[0].threadId).toBe("T-existing");
  });
});
