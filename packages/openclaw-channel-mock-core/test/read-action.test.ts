import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelMockAccountHelpers } from "../src/accounts.js";
import { createBus } from "../src/bus-handler.js";
import { createChannelMockMessageActions, type ChannelSurface } from "../src/plugin-actions.js";

type Fixture = { server: Server; baseUrl: string };

describe("read action", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await start();
  });
  afterEach(async () => {
    await stop(fixture);
  });

  it("reads a Discord thread by its target and ignores a stray threadId", async () => {
    const thread = await createThreadWithStarter(fixture.baseUrl, "discord-mock");
    const messages = await read(fixture.baseUrl, "discord", {
      target: `channel:${thread.id}`,
      threadId: "4d0a2f5b-f0bb-44a0-83ae-3bab3e18683c",
    });
    expect(messages.map((message) => message.text)).toEqual(["Starter"]);
  });

  it("keeps Slack's threadId as the thread filter", async () => {
    const thread = await createThreadWithStarter(fixture.baseUrl, "slack-mock");
    const messages = await read(fixture.baseUrl, "slack", {
      target: "channel:project-x",
      threadId: "unknown-thread",
    });
    expect(messages).toEqual([]);
    const threadMessages = await read(fixture.baseUrl, "slack", {
      target: "channel:project-x",
      threadId: thread.id,
    });
    expect(threadMessages.map((message) => message.text)).toEqual(["Starter"]);
  });
});

async function createThreadWithStarter(baseUrl: string, accountId: string) {
  const { thread } = await post<{ thread: { id: string } }>(baseUrl, "/v1/actions/thread-create", {
    accountId,
    conversationId: "project-x",
    title: "T",
  });
  await post(baseUrl, "/v1/outbound/message", {
    accountId,
    to: `thread:project-x/${thread.id}`,
    text: "Starter",
  });
  return thread;
}

async function read(
  baseUrl: string,
  surface: ChannelSurface,
  params: Record<string, unknown>,
): Promise<Array<{ text: string }>> {
  const channelId = `${surface}-mock`;
  const actions = createChannelMockMessageActions({
    channelId,
    surface,
    helpers: createChannelMockAccountHelpers({ channelId }),
  });
  const handleAction = actions.handleAction as unknown as (
    context: Record<string, unknown>,
  ) => Promise<{ details: { messages: Array<{ text: string }> } }>;
  const result = await handleAction({
    action: "read",
    cfg: { channels: { [channelId]: { baseUrl } } },
    accountId: channelId,
    params,
  });
  return result.details.messages;
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(fixture: Fixture) {
  await new Promise<void>((resolve, reject) => {
    fixture.server.close((error) => (error ? reject(error) : resolve()));
    fixture.server.closeAllConnections?.();
  });
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`request ${path} failed ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
