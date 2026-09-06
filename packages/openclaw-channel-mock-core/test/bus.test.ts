import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../src/bus-handler.js";

type Fixture = { server: Server; baseUrl: string; bus: ReturnType<typeof createBus> };

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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, bus };
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
  if (!response.ok) {
    throw new Error(`request ${path} failed ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

describe("bus HTTP round-trip", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await start();
  });
  afterEach(async () => {
    await stop(fixture);
  });

  it("thread-create + outbound-message + poll yield expected events", async () => {
    const createResp = await post<{ thread: { id: string; conversationId: string } }>(
      fixture.baseUrl,
      "/v1/actions/thread-create",
      { conversationId: "sample-project", title: "T" },
    );
    expect(createResp.thread.id.startsWith("sample-project-thread-")).toBe(true);
    expect(createResp.thread.conversationId).toBe("sample-project");

    await post<{ message: unknown }>(fixture.baseUrl, "/v1/outbound/message", {
      to: `thread:sample-project/${createResp.thread.id}`,
      text: "hi",
      senderId: "openclaw",
    });

    const poll = await post<{
      cursor: number;
      events: Array<{ kind: string; thread?: { id: string }; message?: { threadId?: string } }>;
    }>(fixture.baseUrl, "/v1/poll", { cursor: 0, timeoutMs: 0 });
    expect(poll.events.length).toBeGreaterThanOrEqual(2);
    const kinds = poll.events.map((e) => e.kind);
    expect(kinds).toContain("thread-created");
    expect(kinds).toContain("outbound-message");
    const outbound = poll.events.find((e) => e.kind === "outbound-message");
    expect(outbound?.message?.threadId).toBe(createResp.thread.id);
  });

  it("search rescopes a thread id passed as conversationId (a thread is a channel)", async () => {
    const createResp = await post<{ thread: { id: string } }>(
      fixture.baseUrl,
      "/v1/actions/thread-create",
      { conversationId: "sample-project", title: "T" },
    );
    await post(fixture.baseUrl, "/v1/outbound/message", {
      to: "channel:sample-project",
      text: "root message",
      senderId: "openclaw",
    });
    await post(fixture.baseUrl, "/v1/outbound/message", {
      to: `thread:sample-project/${createResp.thread.id}`,
      text: "thread message",
      senderId: "openclaw",
    });

    const search = await post<{ messages: Array<{ text: string }> }>(
      fixture.baseUrl,
      "/v1/actions/search",
      { conversationId: createResp.thread.id },
    );
    expect(search.messages.map((m) => m.text)).toEqual(["thread message"]);
  });

  it("retains a Discord thread anchor and resolves a thread channel send to its parent", async () => {
    const created = await post<{
      thread: { id: string; conversationId: string; parentMessageId?: string };
    }>(fixture.baseUrl, "/v1/actions/thread-create", {
      conversationId: "Project-With-Case",
      title: "T",
      parentMessageId: "anchor-1",
    });
    expect(created.thread.parentMessageId).toBe("anchor-1");
    const sent = await post<{ message: { conversation: { id: string }; threadId?: string } }>(
      fixture.baseUrl,
      "/v1/outbound/message",
      { to: `channel:${created.thread.id}`, text: "wake" },
    );
    expect(sent.message).toMatchObject({
      conversation: { id: "Project-With-Case" },
      threadId: created.thread.id,
    });
  });

  it("GET /health and /v1/state work", async () => {
    const healthResp = await fetch(`${fixture.baseUrl}/health`);
    expect(healthResp.status).toBe(200);
    const stateResp = await fetch(`${fixture.baseUrl}/v1/state`);
    const state = (await stateResp.json()) as { cursor: number };
    expect(typeof state.cursor).toBe("number");
  });

  it("injects a one-shot native delivery failure", async () => {
    await post(fixture.baseUrl, "/v1/test/fail-next", {
      operation: "outbound-message",
      message: "planned delivery failure",
    });
    await expect(
      post(fixture.baseUrl, "/v1/outbound/message", {
        to: "channel:sample-project",
        text: "first",
      }),
    ).rejects.toThrow(/planned delivery failure/);
    await expect(
      post(fixture.baseUrl, "/v1/outbound/message", {
        to: "channel:sample-project",
        text: "retry",
      }),
    ).resolves.toMatchObject({ message: { text: "retry" } });
  });
});
