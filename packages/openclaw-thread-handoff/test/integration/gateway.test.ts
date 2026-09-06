import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBus, injectQaBusInboundMessage } from "@paleo/openclaw-channel-mock-core";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const OPENCLAW = resolve(REPO_ROOT, "node_modules/.bin/openclaw");
const STARTER = "Project: Project-X\nTask: preserve this exact starter.";
const MARKER = "TARGET_SESSION_STARTED";

type Surface = "slack" | "discord";

type FixtureOptions = {
  duplicateStart?: boolean;
  holdFirstSeed?: boolean;
};

type Fixture = {
  root: string;
  surface: Surface;
  channelId: string;
  bus: ReturnType<typeof createBus>;
  busServer: Server;
  providerServer: Server;
  gateway: ChildProcessWithoutNullStreams;
  gatewayLog: string[];
  providerLog: string[];
  configPath: string;
  stateDir: string;
  inspection: string;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture) await stopFixture(fixture);
  }
});

describe("OpenClaw 2026.9.2 external-plugin gateway", () => {
  it.each(["slack", "discord"] as const)(
    "starts and continues the canonical %s thread without a human nudge",
    async (surface) => {
      const fixture = await startFixture(surface, { duplicateStart: true });
      expect(fixture.inspection).toContain('"origin": "config"');
      expect(fixture.inspection).toContain('"status": "loaded"');

      const rootMessage = await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: "Start the complete task now.",
        },
      });
      const started = await waitForMessage(fixture, (message) => message.text === MARKER);
      const expectedThreadId =
        surface === "slack"
          ? rootMessage.message.id
          : fixture.bus.state.getSnapshot().threads[0]?.id;
      expect(expectedThreadId).toBeTruthy();
      if (!expectedThreadId) throw new Error("native thread ID was not observed");
      expect(started.threadId).toBe(expectedThreadId);
      expect(started.conversation.id).toBe("Project-X");
      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter(
            (message) => message.direction === "outbound" && message.text === STARTER,
          ),
      ).toHaveLength(1);

      const records = JSON.parse(
        await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
      ) as Array<{
        state: string;
        targetSessionKey: string;
        threadId: string;
        sessionId: string;
        parentConversationId: string;
        accountId: string;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        state: "claimed",
        threadId: expectedThreadId,
        parentConversationId: "Project-X",
        accountId: fixture.channelId,
      });
      expect(records[0].sessionId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(records[0].targetSessionKey.toLowerCase()).toContain(expectedThreadId.toLowerCase());
      expect(providerContentIncludes(fixture, '"status": "queued"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "claimed"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "alreadyStarted"')).toBe(true);
      expect(
        surface === "slack"
          ? providerContentIncludes(fixture, '"result"') &&
              providerContentIncludes(fixture, '"threadTs"')
          : providerContentIncludes(fixture, '"thread"') &&
              providerContentIncludes(fixture, '"parentMessageId"'),
      ).toBe(true);

      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: "Continue in this same thread.",
          threadId: expectedThreadId,
        },
      });
      const continued = await waitForMessage(
        fixture,
        (message) => message.text === "SAME_SESSION_CONTINUED",
      );
      expect(continued.threadId).toBe(expectedThreadId);

      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter(
            (message) => message.direction === "outbound" && message.text === MARKER,
          ),
      ).toHaveLength(1);
    },
  );

  it("recovers one pending Slack startup across abrupt and post-claim restarts", async () => {
    const fixture = await startFixture("slack", { holdFirstSeed: true });
    await injectQaBusInboundMessage({
      baseUrl: serverUrl(fixture.busServer),
      input: {
        accountId: fixture.channelId,
        conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
        senderId: "User-A",
        senderName: "User A",
        text: "Start and survive a restart.",
      },
    });
    await waitUntil(
      () => fixture.providerLog.some((entry) => entry.includes("[thread-handoff:v1]")),
      20_000,
      () => "the first pending seed was not observed",
    );
    const pending = JSON.parse(
      await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
    ) as Array<{ state: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("pending");

    await restartGateway(fixture, "SIGKILL");
    await waitForMessage(fixture, (message) => message.text === MARKER, 45_000);
    expect(await handoffStates(fixture)).toEqual(["claimed"]);

    await restartGateway(fixture, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 31_000));
    expect(
      fixture.bus.state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound" && message.text === MARKER),
    ).toHaveLength(1);
    expect(await handoffStates(fixture)).toEqual(["claimed"]);
  }, 90_000);

  it.each(["slack", "discord"] as const)(
    "retries one failed %s native starter without duplicating delivery",
    async (surface) => {
      const fixture = await startFixture(surface);
      fixture.bus.state.failNext({
        operation: surface === "slack" ? "outbound-message" : "thread-create",
        message: "planned recoverable starter failure",
      });
      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: "Recover from one native delivery failure.",
        },
      });
      await waitForMessage(fixture, (message) => message.text === MARKER);
      const snapshot = fixture.bus.state.getSnapshot();
      expect(
        snapshot.messages.filter(
          (message) => message.direction === "outbound" && message.text === STARTER,
        ),
      ).toHaveLength(1);
      if (surface === "discord") expect(snapshot.threads).toHaveLength(1);
      expect(
        fixture.providerLog.some((entry) => entry.includes("planned recoverable starter failure")),
      ).toBe(true);
      expect(await handoffStates(fixture)).toEqual(["claimed"]);
    },
  );
});

async function startFixture(surface: Surface, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), `thread-handoff-${surface}-`));
  const stateDir = resolve(root, "state");
  const workspace = resolve(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "AGENTS.md"), "Use the tools exactly as requested.\n");
  const bus = createBus();
  const busServer = createServer(async (request, response) => {
    if (!(await bus.handler(request, response))) {
      response.statusCode = 404;
      response.end("not found");
    }
  });
  await listen(busServer);
  const providerLog: string[] = [];
  const script = createProviderScript(surface, bus, options);
  const providerServer = createServer(
    (request, response) => void handleProvider(request, response, script, providerLog),
  );
  await listen(providerServer);
  const channelId = `${surface}-mock`;
  const configPath = resolve(root, "openclaw.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      buildConfig({
        surface,
        channelId,
        workspace,
        busUrl: serverUrl(busServer),
        providerUrl: serverUrl(providerServer),
      }),
      null,
      2,
    )}\n`,
  );
  const inspection = await runConfiguredOpenClaw(configPath, stateDir, [
    "plugins",
    "inspect",
    "thread-handoff",
    "--json",
    "--runtime",
  ]);
  const gatewayLog: string[] = [];
  const gateway = await launchGateway(configPath, stateDir, gatewayLog);
  const fixture = {
    root,
    surface,
    channelId,
    bus,
    busServer,
    providerServer,
    gateway,
    gatewayLog,
    providerLog,
    configPath,
    stateDir,
    inspection,
  };
  fixtures.push(fixture);
  return fixture;
}

function buildConfig(params: {
  surface: Surface;
  channelId: string;
  workspace: string;
  busUrl: string;
  providerUrl: string;
}) {
  return {
    gateway: { mode: "local", auth: { mode: "none" } },
    update: { checkOnStart: false },
    plugins: {
      allow: [params.channelId, "thread-handoff"],
      load: {
        paths: [
          resolve(REPO_ROOT, `packages/openclaw-${params.surface}-mock`),
          resolve(REPO_ROOT, "packages/openclaw-thread-handoff"),
        ],
      },
      entries: {
        [params.channelId]: { enabled: true },
        "thread-handoff": {
          enabled: true,
          config: { channelSurfaces: { [params.channelId]: params.surface } },
        },
      },
      slots: { memory: "none" },
    },
    tools: { profile: "coding", alsoAllow: ["message", "thread_handoff"] },
    models: {
      providers: {
        scripted: {
          baseUrl: params.providerUrl,
          apiKey: "test-only",
          api: "openai-completions",
          models: [
            {
              id: "handoff-script",
              name: "Handoff Script",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 2_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: { model: "scripted/handoff-script", workspace: params.workspace },
      entries: { main: { name: "Main" } },
    },
    channels: {
      [params.channelId]: {
        baseUrl: params.busUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw Test",
        allowFrom: ["*"],
        ...(params.surface === "slack" ? { replyToMode: "off" } : {}),
      },
    },
  };
}

function createProviderScript(
  surface: Surface,
  bus: ReturnType<typeof createBus>,
  options: FixtureOptions,
) {
  let callSequence = 0;
  let repeatedStart = false;
  let heldFirstSeed = false;
  return (body: Record<string, unknown>) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tailMessages = messages.slice(-4) as Array<{ role?: unknown; content?: unknown }>;
    const tail = JSON.stringify(tailMessages);
    const latestToolResult = tailMessages.findLast((message) => message.role === "tool")?.content;
    const latestToolText =
      typeof latestToolResult === "string" ? latestToolResult : JSON.stringify(latestToolResult);
    if (tail.includes("Continue in this same thread.")) {
      return { content: "SAME_SESSION_CONTINUED" };
    }
    if (tail.includes("[thread-handoff:v1]")) {
      if (options.holdFirstSeed && !heldFirstSeed) {
        heldFirstSeed = true;
        return { content: "NO_REPLY" };
      }
      const snapshot = bus.state.getSnapshot();
      if (snapshot.messages.some((message) => message.text === MARKER)) {
        return { content: "NO_REPLY" };
      }
      if (latestToolText?.includes('"status": "error"')) {
        return { content: "HANDOFF_CLAIM_FAILED" };
      }
      if (/"status"\s*:\s*"(?:claimed|alreadyClaimed)"/u.test(latestToolText ?? "")) {
        const threadId = resolveThreadId(surface, snapshot);
        return {
          tool: "message",
          arguments: {
            action: "send",
            to: surface === "slack" ? "channel:Project-X" : `channel:${threadId}`,
            ...(surface === "slack" ? { threadId } : {}),
            message: MARKER,
          },
        };
      }
      const handoffId = /handoffId[\\"': ]+([0-9a-f-]{36})/iu.exec(tail)?.[1];
      return {
        tool: "thread_handoff",
        arguments: { action: "claim", ...(handoffId ? { handoffId } : {}) },
      };
    }
    if (/"status"\s*:\s*"queued"/u.test(latestToolText ?? "")) {
      if (options.duplicateStart && !repeatedStart) {
        repeatedStart = true;
        const threadId = resolveThreadId(surface, bus.state.getSnapshot());
        return { tool: "thread_handoff", arguments: { action: "start", threadId } };
      }
      return { content: "NO_REPLY" };
    }
    if (/"status"\s*:\s*"alreadyStarted"/u.test(latestToolText ?? "")) {
      return { content: "NO_REPLY" };
    }
    const snapshot = bus.state.getSnapshot();
    if (
      snapshot.messages.some(
        (message) => message.direction === "outbound" && message.text === STARTER,
      )
    ) {
      const threadId = resolveThreadId(surface, snapshot);
      return { tool: "thread_handoff", arguments: { action: "start", threadId } };
    }
    const root = snapshot.messages.find(
      (message) => message.direction === "inbound" && !message.threadId,
    );
    if (!root) throw new Error("provider received a root turn before the bus message existed");
    callSequence += 1;
    return surface === "slack"
      ? {
          tool: "message",
          arguments: {
            action: "send",
            to: "channel:Project-X",
            threadId: root.id,
            message: STARTER,
          },
          id: `native-starter-${callSequence}`,
        }
      : {
          tool: "message",
          arguments: {
            action: "thread-create",
            to: "channel:Project-X",
            threadName: "Project-X work",
            messageId: root.id,
            message: STARTER,
          },
          id: `native-starter-${callSequence}`,
        };
  };
}

function resolveThreadId(
  surface: Surface,
  snapshot: ReturnType<ReturnType<typeof createBus>["state"]["getSnapshot"]>,
) {
  const threadId =
    surface === "slack"
      ? snapshot.messages.find((message) => message.direction === "inbound")?.id
      : snapshot.threads[0]?.id;
  if (!threadId) throw new Error("provider could not resolve the native thread id");
  return threadId;
}

async function handleProvider(
  request: IncomingMessage,
  response: ServerResponse,
  script: (body: Record<string, unknown>) => {
    content?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    id?: string;
  },
  providerLog: string[],
) {
  if (request.method !== "POST") {
    response.statusCode = 200;
    response.end("ok");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  providerLog.push(JSON.stringify(body));
  const next = script(body);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = next.id ?? `call-${Date.now()}`;
  const delta = next.tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name: next.tool, arguments: JSON.stringify(next.arguments ?? {}) },
          },
        ],
      }
    : { role: "assistant", content: next.content ?? "" };
  response.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: next.tool ? "tool_calls" : "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function waitForMessage(
  fixture: Fixture,
  predicate: (
    message: ReturnType<Fixture["bus"]["state"]["getSnapshot"]>["messages"][number],
  ) => boolean,
  timeoutMs = 20_000,
) {
  let found: ReturnType<Fixture["bus"]["state"]["getSnapshot"]>["messages"][number] | undefined;
  await waitUntil(
    () => {
      found = fixture.bus.state.getSnapshot().messages.find(predicate);
      return found !== undefined;
    },
    timeoutMs,
    () =>
      `message not observed; provider requests: ${fixture.providerLog.length}\n` +
      `gateway log:\n${fixture.gatewayLog.join("")}`,
  );
  if (!found) throw new Error("message wait ended without a match");
  return found;
}

async function handoffStates(fixture: Fixture): Promise<string[]> {
  const records = JSON.parse(
    await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
  ) as Array<{ state: string }>;
  return records.map((record) => record.state);
}

function providerContentIncludes(fixture: Fixture, expected: string) {
  return fixture.providerLog.some((entry) => {
    const body = JSON.parse(entry) as { messages?: Array<{ content?: unknown }> };
    return body.messages?.some(
      (message) => typeof message.content === "string" && message.content.includes(expected),
    );
  });
}

async function restartGateway(fixture: Fixture, signal: NodeJS.Signals) {
  await killGateway(fixture.gateway, signal);
  fixture.gatewayLog.push(`\n--- gateway restart after ${signal} ---\n`);
  fixture.gateway = await launchGateway(fixture.configPath, fixture.stateDir, fixture.gatewayLog);
}

async function launchGateway(configPath: string, stateDir: string, gatewayLog: string[]) {
  const readyOffset = gatewayLog.length;
  const port = await reservePort();
  const gateway = spawn(OPENCLAW, ["gateway", "--port", String(port), "--verbose"], {
    cwd: REPO_ROOT,
    env: buildOpenClawEnv(configPath, stateDir),
    stdio: "pipe",
  });
  gateway.stdout.on("data", (chunk) => gatewayLog.push(String(chunk)));
  gateway.stderr.on("data", (chunk) => gatewayLog.push(String(chunk)));
  await waitUntil(
    () => gatewayLog.slice(readyOffset).join("").includes("thread-handoff persistence ready"),
    30_000,
    () => `gateway did not become ready:\n${gatewayLog.slice(readyOffset).join("")}`,
  );
  return gateway;
}

async function runOpenClaw(fixture: Fixture, args: string[]): Promise<string> {
  return await runConfiguredOpenClaw(fixture.configPath, fixture.stateDir, args);
}

async function runConfiguredOpenClaw(
  configPath: string,
  stateDir: string,
  args: string[],
): Promise<string> {
  return execFileSync(OPENCLAW, args, {
    cwd: REPO_ROOT,
    env: buildOpenClawEnv(configPath, stateDir),
    encoding: "utf8",
  });
}

function buildOpenClawEnv(configPath: string, stateDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["NODE_OPTIONS", "VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID"]) {
    delete env[name];
  }
  return {
    ...env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_NO_UPDATE_CHECK: "1",
  };
}

async function stopFixture(fixture: Fixture) {
  await killGateway(fixture.gateway, "SIGTERM");
  await closeServer(fixture.providerServer);
  await closeServer(fixture.busServer);
  await writeFile(resolve(fixture.root, "gateway.log"), fixture.gatewayLog.join(""));
  await writeFile(
    resolve(fixture.root, "provider-requests.jsonl"),
    `${fixture.providerLog.join("\n")}\n`,
  );
  if (process.env.KEEP_THREAD_HANDOFF_ARTIFACTS !== "1") {
    await rm(fixture.root, { recursive: true });
  }
}

async function killGateway(gateway: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (gateway.exitCode !== null) return;
  gateway.kill(signal);
  await Promise.race([
    new Promise<void>((resolveExit) => gateway.once("exit", () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (gateway.exitCode === null) gateway.kill("SIGKILL");
}

async function listen(server: Server) {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

async function closeServer(server: Server) {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

function serverUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function reservePort() {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve port");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function waitUntil(check: () => boolean, timeoutMs: number, error: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(error());
}
