import { createServer } from "node:http";
import { createBus } from "@alignfirst/openclaw-channel-mock-core";
import { describe, expect, it, onTestFinished } from "vitest";
import { slackMockPlugin } from "../src/plugin.js";

const CHANNEL_ID = "slack-mock";
const actions = slackMockPlugin.actions;

if (!actions?.handleAction || !actions.describeMessageTool || !actions.prepareSendPayload) {
  throw new Error("slack-mock actions missing required adapters");
}
const handleAction: NonNullable<typeof actions.handleAction> = actions.handleAction;
const describeMessageTool: NonNullable<typeof actions.describeMessageTool> =
  actions.describeMessageTool;
const prepareSendPayload: NonNullable<typeof actions.prepareSendPayload> =
  actions.prepareSendPayload;

let baseUrl = "http://unused.invalid";
let bus: ReturnType<typeof createBus>;

function cfg() {
  return {
    channels: {
      [CHANNEL_ID]: {
        baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw Test",
        allowFrom: ["*"],
      },
    },
  };
}

async function startBus() {
  const ownedBus = createBus();
  bus = ownedBus;
  const server = createServer(async (req, res) => {
    if (!(await ownedBus.handler(req, res))) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  onTestFinished(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
    baseUrl = "http://unused.invalid";
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test bus");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function run(action: string, params: Record<string, unknown>) {
  return await handleAction({
    action,
    cfg: cfg() as unknown as Parameters<typeof handleAction>[0]["cfg"],
    accountId: "default",
    params,
  } as unknown as Parameters<typeof handleAction>[0]);
}

describe("slack-mock action surface", () => {
  it("exposes native send but not thread-create or thread-reply", () => {
    const desc = describeMessageTool({
      cfg: cfg() as unknown as Parameters<typeof describeMessageTool>[0]["cfg"],
      accountId: "default",
    } as unknown as Parameters<typeof describeMessageTool>[0]);
    if (!desc) throw new Error("describeMessageTool returned no descriptor");
    const set = new Set(desc.actions);
    for (const wanted of ["send", "read", "edit", "delete", "react", "reactions", "search"]) {
      expect(set.has(wanted as never)).toBe(true);
    }
    for (const forbidden of ["thread-create", "thread-reply"]) {
      expect(set.has(forbidden as never)).toBe(false);
    }
  });

  it("prepares sends for core delivery and rejects the plugin send path", async () => {
    await startBus();
    const payload = { text: "  exact starter\nbody  " };
    expect(
      await prepareSendPayload({ ctx: { action: "send" }, payload } as unknown as Parameters<
        typeof prepareSendPayload
      >[0]),
    ).toBe(payload);
    expect(
      await prepareSendPayload({ ctx: { action: "read" }, payload } as unknown as Parameters<
        typeof prepareSendPayload
      >[0]),
    ).toBeNull();
    await expect(
      run("send", { to: "channel:Sample-Project", text: payload.text }),
    ).rejects.toThrow();
  });

  it("returns the bus-resolved target and thread from the message adapter", async () => {
    await startBus();
    const sendText = slackMockPlugin.message?.send?.text;
    if (!sendText) throw new Error("slack-mock message adapter missing send.text");
    const result = await sendText({
      cfg: cfg(),
      accountId: "default",
      to: "channel:Sample-Project",
      text: "  exact starter\nbody  ",
      threadId: "171.0001",
    } as unknown as Parameters<typeof sendText>[0]);

    expect(result).toMatchObject({
      target: { kind: "channel", id: "Sample-Project" },
      receipt: { threadId: "171.0001" },
    });
    expect(bus.state.getSnapshot().messages[0]).toMatchObject({
      conversation: { id: "Sample-Project" },
      threadId: "171.0001",
      text: "  exact starter\nbody  ",
    });
  });

  it("rejects thread-create and thread-reply", async () => {
    await startBus();
    const thread = bus.state.createThread({
      accountId: "default",
      conversationId: "sample-project",
      title: "Existing thread",
    });
    await expect(run("thread-create", { to: "sample-project", title: "x" })).rejects.toThrow();
    await expect(
      run("thread-reply", { to: "sample-project", threadId: thread.id, text: "x" }),
    ).rejects.toThrow();
    expect(bus.state.getSnapshot().threads).toHaveLength(1);
    expect(bus.state.getSnapshot().messages).toEqual([]);
  });
});
