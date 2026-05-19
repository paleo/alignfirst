import { createServer, type Server } from "node:http";
import {
  createBus,
  createChannelMockAccountHelpers,
  createChannelMockMessageActions,
} from "@paleo/openclaw-channel-mock-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHANNEL_ID = "discord-mock";

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

const helpers = createChannelMockAccountHelpers({ channelId: CHANNEL_ID });
const actions = createChannelMockMessageActions({
  channelId: CHANNEL_ID,
  surface: "discord",
  helpers,
});

if (!actions.handleAction || !actions.describeMessageTool) {
  throw new Error("discord-mock actions missing handleAction/describeMessageTool");
}
const handleAction: NonNullable<typeof actions.handleAction> = actions.handleAction;
const describeMessageTool: NonNullable<typeof actions.describeMessageTool> =
  actions.describeMessageTool;

function makeCfg(baseUrl: string) {
  return {
    channels: {
      [CHANNEL_ID]: {
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
      },
    },
  } as const;
}

async function runHandler(fixture: BusFixture, action: string, params: Record<string, unknown>) {
  return await handleAction({
    action,
    cfg: makeCfg(fixture.baseUrl) as unknown as Parameters<typeof handleAction>[0]["cfg"],
    accountId: "default",
    params,
  } as unknown as Parameters<typeof handleAction>[0]);
}

describe("discord-mock handleAction (post-normalization shape)", () => {
  let fixture: BusFixture;
  beforeEach(async () => {
    fixture = await startBus();
  });
  afterEach(async () => {
    await stopBus(fixture);
  });

  it("send with `to` posts to the channel", async () => {
    await runHandler(fixture, "send", { to: "sample-project", text: "hello" });
    const snap = fixture.bus.state.getSnapshot();
    expect(snap.messages.length).toBe(1);
    expect(snap.messages[0].text).toBe("hello");
    expect(snap.messages[0].conversation.id).toBe("sample-project");
  });

  it("send with thread target posts to the thread", async () => {
    await runHandler(fixture, "send", { to: "thread:sample-project/T1", text: "in thread" });
    const snap = fixture.bus.state.getSnapshot();
    expect(snap.messages[0].threadId).toBe("T1");
  });

  it("thread-create with text posts the body atomically", async () => {
    const created = (await runHandler(fixture, "thread-create", {
      to: "sample-project",
      title: "Topic",
      text: "first thread message",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(created.content[0].text);
    expect(payload.threadId).toBeTruthy();
    expect(payload.message).toBeTruthy();
    const snap = fixture.bus.state.getSnapshot();
    expect(snap.threads.length).toBe(1);
    expect(snap.messages.length).toBe(1);
    expect(snap.messages[0].text).toBe("first thread message");
    expect(snap.messages[0].threadId).toBe(payload.threadId);
  });

  it("thread-create without text creates the thread only", async () => {
    await runHandler(fixture, "thread-create", { to: "sample-project", title: "Topic" });
    const snap = fixture.bus.state.getSnapshot();
    expect(snap.threads.length).toBe(1);
    expect(snap.messages.length).toBe(0);
  });

  it("thread-reply posts to the thread", async () => {
    const thread = fixture.bus.state.createThread({
      accountId: "default",
      conversationId: "sample-project",
      title: "T",
    });
    await runHandler(fixture, "thread-reply", {
      to: "sample-project",
      threadId: thread.id,
      text: "reply body",
    });
    const snap = fixture.bus.state.getSnapshot();
    const reply = snap.messages.find((m) => m.threadId === thread.id);
    expect(reply).toBeTruthy();
    expect(reply?.text).toBe("reply body");
  });

  it("react/read/edit/delete on normalized shape", async () => {
    const sent = await runHandler(fixture, "send", { to: "sample-project", text: "first" });
    const messageId = JSON.parse((sent as { content: Array<{ text: string }> }).content[0].text)
      .message.id as string;
    await runHandler(fixture, "react", { messageId, emoji: "👍" });
    await runHandler(fixture, "edit", { messageId, text: "edited" });
    const read = (await runHandler(fixture, "read", { messageId })) as {
      content: Array<{ text: string }>;
    };
    const readMsg = JSON.parse(read.content[0].text).message;
    expect(readMsg.text).toBe("edited");
    expect(readMsg.reactions.length).toBe(1);
    await runHandler(fixture, "delete", { messageId });
    expect(fixture.bus.state.getSnapshot().messages[0].deleted).toBe(true);
  });

  it("describeMessageTool exposes the full Discord surface", () => {
    const desc = describeMessageTool({
      cfg: makeCfg("http://x") as unknown as Parameters<typeof describeMessageTool>[0]["cfg"],
      accountId: "default",
    } as unknown as Parameters<typeof describeMessageTool>[0]);
    if (!desc) throw new Error("describeMessageTool returned no descriptor");
    const set = new Set(desc.actions);
    for (const wanted of [
      "send",
      "thread-create",
      "thread-reply",
      "read",
      "edit",
      "delete",
      "react",
      "reactions",
      "search",
    ]) {
      expect(set.has(wanted as never)).toBe(true);
    }
  });
});
