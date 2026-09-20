import {
  createChannelMockAccountHelpers,
  createChannelMockMessageActions,
  createChannelMockPlugin,
} from "@alignfirst/openclaw-channel-mock-core";
import { createServer, type Server } from "node:http";
import { createBus } from "@alignfirst/openclaw-channel-mock-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHANNEL_ID = "slack-mock";
const helpers = createChannelMockAccountHelpers({ channelId: CHANNEL_ID });
const actions = createChannelMockMessageActions({
  channelId: CHANNEL_ID,
  surface: "slack",
  helpers,
});

if (!actions.handleAction || !actions.describeMessageTool || !actions.prepareSendPayload) {
  throw new Error("slack-mock actions missing required adapters");
}
const handleAction: NonNullable<typeof actions.handleAction> = actions.handleAction;
const describeMessageTool: NonNullable<typeof actions.describeMessageTool> =
  actions.describeMessageTool;
const prepareSendPayload: NonNullable<typeof actions.prepareSendPayload> =
  actions.prepareSendPayload;

let server: Server;
let baseUrl: string;
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

beforeEach(async () => {
  bus = createBus();
  server = createServer(async (req, res) => {
    if (!(await bus.handler(req, res))) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test bus");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
});

async function run(action: string, params: Record<string, unknown>) {
  return await handleAction({
    action,
    cfg: cfg() as unknown as Parameters<typeof handleAction>[0]["cfg"],
    accountId: "default",
    params,
  } as unknown as Parameters<typeof handleAction>[0]);
}

describe("slack-mock action surface", () => {
  it("exposes native send but not fake thread creation or rename", () => {
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
    await expect(run("send", { to: "channel:Sample-Project", text: payload.text })).rejects.toThrow(
      /must use OpenClaw core delivery/,
    );
  });

  it("returns the bus-resolved target and thread from the message adapter", async () => {
    const plugin = createChannelMockPlugin({
      channelId: CHANNEL_ID,
      label: "Slack Mock",
      surface: "slack",
      autoThread: true,
      getRuntime: () => {
        throw new Error("runtime is not used by the message adapter");
      },
    });
    const sendText = plugin.message?.send?.text;
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

  it("continues to reject fake Slack creation and rename actions", async () => {
    await expect(run("thread-create", { to: "sample-project", title: "x" })).rejects.toThrow(
      /does not expose action/,
    );
    await expect(
      run("thread-reply", { to: "sample-project", threadId: "T", text: "x" }),
    ).rejects.toThrow(/does not expose action/);
  });
});
