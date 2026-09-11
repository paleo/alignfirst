import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBus, injectQaBusInboundMessage } from "@paleo/openclaw-channel-mock-core";
import { buildAgentSessionKey, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { SILENT_TOKEN } from "../../src/thread-handoff/service.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const OPENCLAW = resolve(REPO_ROOT, "node_modules/.bin/openclaw");
const STARTER = "Project: Project-X\nTask: preserve this exact starter.";
const MARKER = "TARGET_SESSION_STARTED";
const RESTART_RECOVERY_PROMPT = "Your previous turn was interrupted by a gateway restart";
const CHAINED_WAKE = "alcode run finished — read its session file and report to the user";
const WAKE_REPORTED = "WAKE_REPORTED";
const RACING_HUMAN = "RACING_HUMAN_REPLY";
const RACING_HUMAN_HANDLED = "RACING_HUMAN_HANDLED";
const HUMAN_DURING_SEED = "HUMAN_DURING_SEED_REPLY";
const HUMAN_DURING_SEED_HANDLED = "HUMAN_DURING_SEED_HANDLED";
const HUMAN_THREAD_ROOT = "HUMAN_THREAD_ROOT";
const HUMAN_THREAD_START = "HUMAN_THREAD_START";
const HUMAN_THREAD_STARTED = "HUMAN_THREAD_STARTED";
const REFUSED_CHANNEL_WAKE = "REFUSED_CHANNEL_WAKE";
const execFileAsync = promisify(execFile);

type Surface = "slack" | "discord";

type FixtureOptions = {
  claimTwice?: boolean;
  duplicateStart?: boolean;
  holdFirstSeed?: boolean;
  silenceAfterClaim?: boolean;
  stallChannelReplyMs?: number;
  stallEndsAt?: number;
  stallSeedReplyMs?: number;
  seedStallStartedAt?: number;
};

type Fixture = {
  root: string;
  surface: Surface;
  channelId: string;
  bus: ReturnType<typeof createBus>;
  busServer: Server;
  providerServer: Server;
  gateway: ChildProcessWithoutNullStreams;
  gatewayPort: number;
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

describe("OpenClaw 2026.9.3 external-plugin gateway", () => {
  it.each(["slack", "discord", "slack", "discord", "slack", "discord"] as const)(
    "keeps a claimed %s seed silent while awaiting a human answer",
    async (surface) => {
      const fixture = await startFixture(surface, { silenceAfterClaim: true });
      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          text: "Start a task that needs a human answer.",
        },
      });
      await waitUntil(
        () => providerContentIncludes(fixture, '"status": "claimed"'),
        20_000,
        () => `claim result not observed\n${fixture.gatewayLog.join("")}`,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
      expect(
        fixture.gatewayLog.some((line) => line.includes("running isolated finalization")),
      ).toBe(false);
      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => message.text),
      ).toEqual([STARTER]);
    },
  );

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
        attemptCount: number;
        claimedBy: { sessionId: string };
      }>;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        state: "claimed",
        threadId: expectedThreadId,
        parentConversationId: "Project-X",
        accountId: fixture.channelId,
      });
      expect(records[0]).toMatchObject({
        attemptCount: 1,
        claimedBy: { sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u) },
      });
      expect(records[0].targetSessionKey.toLowerCase()).toContain(expectedThreadId.toLowerCase());
      expect(providerContentIncludes(fixture, '"status": "queued"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "claimed"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "alreadyStarted"')).toBe(true);
      expect(
        surface === "slack"
          ? providerContentIncludes(fixture, '"receipt"') &&
              providerContentIncludes(fixture, '"deliveryStatus"')
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
        fixture.gatewayLog.some((line) => line.includes("running isolated finalization")),
      ).toBe(false);

      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter(
            (message) => message.direction === "outbound" && message.text === MARKER,
          ),
      ).toHaveLength(1);
    },
  );

  it.each(["slack", "discord"] as const)(
    "preserves a %s human reply racing the first seed turn",
    async (surface) => {
      const fixture = await startFixture(surface);
      const rootMessage = await injectRootMessage(fixture, "Project-X", "Start with a reply.");
      await waitForMessage(fixture, (message) => message.text === STARTER);
      const threadId =
        surface === "slack"
          ? rootMessage.message.id
          : fixture.bus.state.getSnapshot().threads[0]?.id;
      if (!threadId) throw new Error("native thread ID was not observed");

      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: RACING_HUMAN,
          threadId,
        },
      });

      const handled = await waitForMessage(
        fixture,
        (message) => message.text === RACING_HUMAN_HANDLED,
      );
      expect(handled.threadId).toBe(threadId);
      expect(fixture.gatewayLog.join("")).not.toContain(
        "restart recovery claim changed before agent adoption",
      );
    },
  );

  it.each(["slack", "discord"] as const)(
    "delivers a %s human message sent while the seed turn runs",
    async (surface) => {
      const options: FixtureOptions = { stallSeedReplyMs: 8_000 };
      const fixture = await startFixture(surface, options);
      const rootMessage = await injectRootMessage(fixture, "Project-X", "Start, reply mid-seed.");
      await waitUntil(
        () => options.seedStallStartedAt !== undefined,
        20_000,
        () => `the seed turn did not enter its scripted stall\n${fixture.gatewayLog.join("")}`,
      );
      const threadId =
        surface === "slack"
          ? rootMessage.message.id
          : fixture.bus.state.getSnapshot().threads[0]?.id;
      if (!threadId) throw new Error("native thread ID was not observed");

      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: HUMAN_DURING_SEED,
          threadId,
        },
      });

      await waitForMessage(fixture, (message) => message.text === MARKER);
      const handled = await waitForMessage(
        fixture,
        (message) => message.text === HUMAN_DURING_SEED_HANDLED,
        30_000,
      );
      expect(handled.threadId).toBe(threadId);
    },
  );

  it.each(["slack", "discord"] as const)(
    "keeps a repeated %s claim idempotent inside the seed turn",
    async (surface) => {
      const fixture = await startFixture(surface, { claimTwice: true });
      await injectRootMessage(fixture, "Project-X", "Start a task and claim it twice.");
      await waitForMessage(fixture, (message) => message.text === MARKER);
      expect(providerContentCount(fixture, '"status": "claimed"')).toBeGreaterThanOrEqual(2);
      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter(
            (message) => message.direction === "outbound" && message.text === MARKER,
          ),
      ).toHaveLength(1);
    },
  );

  it.each(["slack", "discord"] as const)(
    "delivers a chained %s wake through the session's persisted route",
    async (surface) => {
      const fixture = await startFixture(surface);
      await injectRootMessage(fixture, "Project-X", "Start before the chained wake.");
      const marker = await waitForMessage(fixture, (message) => message.text === MARKER);
      const records = JSON.parse(
        await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
      ) as Array<{ targetSessionKey: string }>;
      await runOpenClaw(fixture, [
        "thread-handoff",
        "wake",
        "--session-key",
        records[0]?.targetSessionKey ?? "missing-session",
        "--message",
        CHAINED_WAKE,
      ]);
      const reported = await waitForMessage(fixture, (message) => message.text === WAKE_REPORTED);
      expect(reported.threadId).toBe(marker.threadId);
    },
  );

  it.each(["slack", "discord"] as const)(
    "wakes a human-started %s thread through its last route",
    async (surface) => {
      const fixture = await startFixture(surface);
      const root = await injectRootMessage(fixture, "Project-X", HUMAN_THREAD_ROOT);
      const threadId =
        surface === "slack"
          ? root.message.id
          : fixture.bus.state.createThread({
              accountId: fixture.channelId,
              conversationId: "Project-X",
              title: "Human-started work",
              createdBy: "User-A",
              parentMessageId: root.message.id,
            }).id;

      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          senderName: "User A",
          text: HUMAN_THREAD_START,
          threadId,
        },
      });
      const started = await waitForMessage(
        fixture,
        (message) => message.text === HUMAN_THREAD_STARTED,
      );
      expect(started.threadId).toBe(threadId);

      await runOpenClaw(fixture, [
        "thread-handoff",
        "wake",
        "--session-key",
        buildHumanThreadSessionKey(fixture, threadId),
        "--message",
        CHAINED_WAKE,
      ]);
      const reported = await waitForMessage(fixture, (message) => message.text === WAKE_REPORTED);
      expect(reported.threadId).toBe(threadId);
    },
  );

  it("refuses a Slack channel session wake", async () => {
    const fixture = await startFixture("slack");
    await injectRootMessage(fixture, "Project-X", "Start before refusing the channel wake.");
    await waitForMessage(fixture, (message) => message.text === MARKER);
    const records = JSON.parse(
      await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
    ) as Array<{ targetSessionKey: string }>;
    const channelSessionKey = (records[0]?.targetSessionKey ?? "").replace(/:thread:[^:]+$/u, "");

    await expect(
      runOpenClaw(fixture, [
        "thread-handoff",
        "wake",
        "--session-key",
        channelSessionKey,
        "--message",
        REFUSED_CHANNEL_WAKE,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Slack thread wake requires a thread session."),
    });
    expect(providerContentIncludes(fixture, REFUSED_CHANNEL_WAKE)).toBe(false);
  });

  it.each(["slack", "discord"] as const)(
    "starts two concurrent %s handoffs behind a running sibling turn",
    async (surface) => {
      const options: FixtureOptions = { stallChannelReplyMs: 8_000 };
      const fixture = await startFixture(surface, options);
      await injectRootMessage(fixture, "Project-X", "Keep this turn busy.");
      await waitUntil(
        () => options.stallEndsAt !== undefined,
        5_000,
        () => "the sibling turn did not enter its scripted stall",
      );
      await Promise.all([
        injectRootMessage(fixture, "Project-Y", "Start task Y."),
        injectRootMessage(fixture, "Project-Z", "Start task Z."),
      ]);
      await waitUntil(
        () => outboundMessages(fixture, MARKER).length === 2,
        20_000,
        () => `concurrent handoffs did not finish\n${fixture.gatewayLog.join("")}`,
      );
      const stallEndsAt = options.stallEndsAt;
      if (stallEndsAt === undefined) throw new Error("the sibling stall deadline is unavailable");
      expect(
        outboundMessages(fixture, MARKER).every((message) => message.timestamp < stallEndsAt),
      ).toBe(true);
      expect(await handoffStates(fixture)).toEqual(["claimed", "claimed"]);
    },
  );

  it("recovers one pending Slack startup across abrupt and post-claim restarts", async () => {
    const options = { holdFirstSeed: true };
    const fixture = await startFixture("slack", options);
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

    options.holdFirstSeed = false;
    await restartGateway(fixture, "SIGKILL");
    await waitForMessage(fixture, (message) => message.text === MARKER, 150_000);
    expect(await handoffStates(fixture)).toEqual(["claimed"]);
    expect(await handoffAttempts(fixture)).toEqual([2]);

    await restartGateway(fixture, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 65_000));
    expect(
      fixture.bus.state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound" && message.text === MARKER),
    ).toHaveLength(1);
    expect(await handoffStates(fixture)).toEqual(["claimed"]);
  }, 300_000);

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
  const gatewayPort = await reservePort();
  await writeFile(
    configPath,
    `${JSON.stringify(
      buildConfig({
        surface,
        channelId,
        workspace,
        busUrl: serverUrl(busServer),
        providerUrl: serverUrl(providerServer),
        gatewayPort,
      }),
      null,
      2,
    )}\n`,
  );
  const inspection = await runConfiguredOpenClaw(configPath, stateDir, [
    "plugins",
    "inspect",
    "alignfirst-developer",
    "--json",
    "--runtime",
  ]);
  const gatewayLog: string[] = [];
  const gateway = await launchGateway(configPath, stateDir, gatewayPort, gatewayLog);
  const fixture = {
    root,
    surface,
    channelId,
    bus,
    busServer,
    providerServer,
    gateway,
    gatewayPort,
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
  gatewayPort: number;
}) {
  return {
    gateway: { mode: "local", port: params.gatewayPort, auth: { mode: "none" } },
    update: { checkOnStart: false },
    plugins: {
      allow: [params.channelId, "alignfirst-developer"],
      load: {
        paths: [
          resolve(REPO_ROOT, `packages/openclaw-${params.surface}-mock`),
          resolve(REPO_ROOT, "packages/alignfirst-developer-openclaw-plugin"),
        ],
      },
      entries: {
        [params.channelId]: { enabled: true },
        "alignfirst-developer": {
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
      defaults: {
        model: "scripted/handoff-script",
        workspace: params.workspace,
        maxConcurrent: 4,
        heartbeat: { target: "last" },
      },
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
  let repeatedClaim = false;
  return (body: Record<string, unknown>) => {
    if (options.silenceAfterClaim && !Array.isArray(body.tools)) return { content: "NO_REPLY" };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allMessages = messages as Array<{ role?: unknown; content?: unknown }>;
    const tailMessages = allMessages.slice(-4);
    const tail = JSON.stringify(tailMessages);
    const all = JSON.stringify(allMessages);
    const latestToolResult = tailMessages.findLast((message) => message.role === "tool")?.content;
    const latestToolText =
      typeof latestToolResult === "string" ? latestToolResult : JSON.stringify(latestToolResult);
    const latestUserText = allMessages
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    if (all.includes("Keep this turn busy.")) {
      const delayMs = options.stallChannelReplyMs ?? 0;
      options.stallEndsAt = Date.now() + delayMs;
      return { content: "NO_REPLY", delayMs };
    }
    if (tail.includes(RESTART_RECOVERY_PROMPT) && !tail.includes("[thread-handoff:v1]")) {
      return { content: "NO_REPLY" };
    }
    if (tail.includes("Continue in this same thread.")) {
      return { content: "SAME_SESSION_CONTINUED" };
    }
    if (tail.includes(CHAINED_WAKE)) return { content: WAKE_REPORTED };
    if (latestUserText.includes(HUMAN_THREAD_ROOT)) return { content: "NO_REPLY" };
    if (latestUserText.includes(HUMAN_THREAD_START)) return { content: HUMAN_THREAD_STARTED };
    if (latestUserText.includes(RACING_HUMAN)) return { content: RACING_HUMAN_HANDLED };
    if (latestUserText.includes(HUMAN_DURING_SEED)) return { content: HUMAN_DURING_SEED_HANDLED };
    if (all.includes("[thread-handoff:v1]")) {
      if (options.holdFirstSeed) return { content: SILENT_TOKEN };
      const snapshot = bus.state.getSnapshot();
      const conversationId = resolveConversationId(snapshot, all);
      if (
        snapshot.messages.some(
          (message) => message.text === MARKER && message.conversation.id === conversationId,
        )
      ) {
        return { content: "NO_REPLY" };
      }
      if (latestToolText?.includes('"status": "error"')) {
        return { content: "HANDOFF_CLAIM_FAILED" };
      }
      if (/"status"\s*:\s*"(?:claimed|alreadyClaimed)"/u.test(latestToolText ?? "")) {
        if (options.claimTwice && !repeatedClaim) {
          repeatedClaim = true;
          const handoffId = /handoffId[\\"': ]+([0-9a-f-]{36})/iu.exec(all)?.[1];
          return {
            tool: "thread_handoff",
            arguments: { action: "claim", ...(handoffId ? { handoffId } : {}) },
          };
        }
        if (options.silenceAfterClaim) return { content: SILENT_TOKEN };
        if (options.stallSeedReplyMs !== undefined && options.seedStallStartedAt === undefined) {
          options.seedStallStartedAt = Date.now();
          return { content: MARKER, delayMs: options.stallSeedReplyMs };
        }
        return { content: MARKER };
      }
      const handoffId = /handoffId[\\"': ]+([0-9a-f-]{36})/iu.exec(all)?.[1];
      return {
        tool: "thread_handoff",
        arguments: { action: "claim", ...(handoffId ? { handoffId } : {}) },
      };
    }
    if (/"status"\s*:\s*"queued"/u.test(latestToolText ?? "")) {
      if (options.duplicateStart && !repeatedStart) {
        repeatedStart = true;
        const snapshot = bus.state.getSnapshot();
        const conversationId = resolveConversationId(snapshot, all);
        const threadId = resolveThreadId(surface, snapshot, conversationId);
        return { tool: "thread_handoff", arguments: { action: "start", threadId } };
      }
      return { content: "NO_REPLY" };
    }
    if (/"status"\s*:\s*"alreadyStarted"/u.test(latestToolText ?? "")) {
      return { content: "NO_REPLY" };
    }
    const snapshot = bus.state.getSnapshot();
    const conversationId = resolveConversationId(snapshot, all);
    if (
      snapshot.messages.some(
        (message) =>
          message.direction === "outbound" &&
          message.text === STARTER &&
          message.conversation.id === conversationId,
      )
    ) {
      const threadId = resolveThreadId(surface, snapshot, conversationId);
      return { tool: "thread_handoff", arguments: { action: "start", threadId } };
    }
    const root = snapshot.messages.find(
      (message) =>
        message.direction === "inbound" &&
        !message.threadId &&
        message.conversation.id === conversationId,
    );
    if (!root) throw new Error("provider received a root turn before the bus message existed");
    callSequence += 1;
    return surface === "slack"
      ? {
          tool: "message",
          arguments: {
            action: "send",
            to: `channel:${conversationId}`,
            threadId: root.id,
            message: STARTER,
          },
          id: `native-starter-${callSequence}`,
        }
      : {
          tool: "message",
          arguments: {
            action: "thread-create",
            to: `channel:${conversationId}`,
            threadName: `${conversationId} work`,
            messageId: root.id,
            message: STARTER,
          },
          id: `native-starter-${callSequence}`,
        };
  };
}

function buildHumanThreadSessionKey(fixture: Fixture, threadId: string): string {
  const channelSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: fixture.channelId,
    peer: { kind: "channel", id: "Project-X" },
  });
  return fixture.surface === "slack"
    ? resolveThreadSessionKeys({ baseSessionKey: channelSessionKey, threadId }).sessionKey
    : buildAgentSessionKey({
        agentId: "main",
        channel: fixture.channelId,
        peer: { kind: "channel", id: threadId },
      });
}

function resolveThreadId(
  surface: Surface,
  snapshot: ReturnType<ReturnType<typeof createBus>["state"]["getSnapshot"]>,
  conversationId: string,
) {
  const threadId =
    surface === "slack"
      ? snapshot.messages.find(
          (message) =>
            message.direction === "inbound" &&
            !message.threadId &&
            message.conversation.id === conversationId,
        )?.id
      : snapshot.threads.find((thread) => thread.conversationId === conversationId)?.id;
  if (!threadId) throw new Error("provider could not resolve the native thread id");
  return threadId;
}

function resolveConversationId(
  snapshot: ReturnType<ReturnType<typeof createBus>["state"]["getSnapshot"]>,
  messages: string,
): string {
  const conversation = snapshot.conversations.findLast((candidate) =>
    messages.includes(candidate.id),
  );
  if (!conversation) throw new Error("provider could not resolve the conversation");
  return conversation.id;
}

async function handleProvider(
  request: IncomingMessage,
  response: ServerResponse,
  script: (body: Record<string, unknown>) => {
    content?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    id?: string;
    delayMs?: number;
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
  if (next.delayMs) await new Promise((resolveWait) => setTimeout(resolveWait, next.delayMs));
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

function outboundMessages(fixture: Fixture, text: string) {
  return fixture.bus.state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound" && message.text === text);
}

async function handoffStates(fixture: Fixture): Promise<string[]> {
  const records = JSON.parse(
    await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
  ) as Array<{ state: string }>;
  return records.map((record) => record.state);
}

async function handoffAttempts(fixture: Fixture): Promise<number[]> {
  const records = JSON.parse(
    await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
  ) as Array<{ attemptCount: number }>;
  return records.map((record) => record.attemptCount);
}

function providerContentIncludes(fixture: Fixture, expected: string) {
  return fixture.providerLog.some((entry) => {
    const body = JSON.parse(entry) as { messages?: Array<{ content?: unknown }> };
    return body.messages?.some(
      (message) => typeof message.content === "string" && message.content.includes(expected),
    );
  });
}

function providerContentCount(fixture: Fixture, expected: string): number {
  return fixture.providerLog.filter((entry) => {
    const body = JSON.parse(entry) as { messages?: Array<{ content?: unknown }> };
    return body.messages?.some(
      (message) => typeof message.content === "string" && message.content.includes(expected),
    );
  }).length;
}

async function injectRootMessage(fixture: Fixture, conversationId: string, text: string) {
  return await injectQaBusInboundMessage({
    baseUrl: serverUrl(fixture.busServer),
    input: {
      accountId: fixture.channelId,
      conversation: { kind: "channel", id: conversationId, title: conversationId },
      senderId: "User-A",
      senderName: "User A",
      text,
    },
  });
}

async function restartGateway(fixture: Fixture, signal: NodeJS.Signals) {
  await killGateway(fixture.gateway, signal);
  fixture.gatewayLog.push(`\n--- gateway restart after ${signal} ---\n`);
  fixture.gateway = await launchGateway(
    fixture.configPath,
    fixture.stateDir,
    fixture.gatewayPort,
    fixture.gatewayLog,
  );
}

async function launchGateway(
  configPath: string,
  stateDir: string,
  port: number,
  gatewayLog: string[],
) {
  const readyOffset = gatewayLog.length;
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
  const result = await execFileAsync(OPENCLAW, args, {
    cwd: REPO_ROOT,
    env: buildOpenClawEnv(configPath, stateDir),
    encoding: "utf8",
  });
  return result.stdout;
}

function buildOpenClawEnv(configPath: string, stateDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["NODE_OPTIONS", "VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID"]) {
    delete env[name];
  }
  return {
    ...env,
    PATH: `${resolve(REPO_ROOT, "node_modules/.bin")}:${env.PATH ?? ""}`,
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
  const childPids = await readChildPids(gateway.pid);
  gateway.kill(signal);
  await Promise.race([
    new Promise<void>((resolveExit) => gateway.once("exit", () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (gateway.exitCode === null) gateway.kill("SIGKILL");
  await waitForProcessExit(childPids, 5_000);
}

async function readChildPids(parentPid: number | undefined): Promise<number[]> {
  if (parentPid === undefined) return [];
  try {
    const contents = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8");
    return contents
      .trim()
      .split(/\s+/u)
      .filter((value) => value.length > 0)
      .map(Number);
  } catch {
    return [];
  }
}

async function waitForProcessExit(processIds: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIds.some((processId) => processExists(processId)) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
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
