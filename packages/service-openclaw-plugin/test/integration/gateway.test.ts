import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createBus, injectQaBusInboundMessage } from "@alignfirst/openclaw-channel-mock-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import { killGateway, observeGateway } from "./gateway-process.js";
import {
  claimStatus,
  observedClaims,
  requireClaimOwnership,
  successfulRun,
  toolObservations,
  type HandoffObservation,
} from "./gateway-observation.js";
import {
  createProviderScript,
  createProviderGate,
  resolveThreadId,
  TAKEOVER_MESSAGE,
  FINALIZER_ANSWER,
  STARTER,
  MARKER,
  RACING_HUMAN,
  RACING_HUMAN_HANDLED,
  HUMAN_DURING_SEED,
  HUMAN_DURING_SEED_HANDLED,
  type FixtureOptions,
  type ProviderReply,
  type ProviderScript,
} from "./gateway-provider.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const PACKED_ROOT = process.env.THREAD_HANDOFF_PACKED_ROOT;
const OPENCLAW = resolve(PACKED_ROOT ?? REPO_ROOT, "node_modules/.bin/openclaw");

const BOT_MENTION = "@openclaw";

const FINALIZER_FALLBACK = "no final summary was produced";

const execFileAsync = promisify(execFile);
const fixtures: FixtureOwner[] = [];

type Surface = "slack" | "discord";

interface Fixture {
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
  owner: FixtureOwner;
}

interface FixtureOwner {
  root: string;
  servers: Server[];
  gateways: Set<ChildProcessWithoutNullStreams>;
  handlers: Set<Promise<void>>;
  options: FixtureOptions;
  failures: unknown[];
  gatewayLog: string[];
  providerLog: string[];
  providerScript?: ProviderScript;
}

afterEach(async () => {
  const failures: unknown[] = [];
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    try {
      await stopFixture(fixture);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Gateway fixture cleanup failed");
});

describe("OpenClaw external-plugin gateway", () => {
  it.each(["slack", "discord"] as const)(
    "claims and delivers a %s native exec completion on its canonical thread",
    async (surface) => {
      const fixture = await startFixture(surface, { nativeExecCompletion: true });
      await injectRootMessage(fixture, "Project-X", "Start native completion verification.");
      const completed = await waitForMessage(
        fixture,
        (message) => message.text === "NATIVE_COMPLETION_REPORTED",
        40_000,
      );
      const threadId = resolveThreadId(surface, fixture.bus.state.getSnapshot(), "Project-X");
      expect(completed.threadId).toBe(threadId);
      expect(completed.conversation.id).toBe("Project-X");
      expect(providerContentIncludes(fixture, "Exec completed (")).toBe(true);
      expect(providerContentIncludes(fixture, "NATIVE_EXEC_OUTPUT")).toBe(true);
      expect([...providerClaimResults(fixture).values()]).toEqual(["claimed", "alreadyClaimed"]);
      const contexts = (await readFile(resolve(fixture.root, "tool-contexts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): OpenClawPluginToolContext => JSON.parse(line));
      expect(contexts).toContainEqual(
        expect.objectContaining({
          sessionKey: canonicalSessionKey(fixture, threadId),
          deliveryContext: expect.objectContaining({
            channel: fixture.channelId,
            to: surface === "slack" ? "Project-X" : `channel:${threadId}`,
          }),
        }),
      );
      const completionContexts = contexts.filter(
        (context) =>
          context.nativeChannelId === undefined && context.deliveryContext?.to !== undefined,
      );
      expect(completionContexts).not.toHaveLength(0);
      expect(
        completionContexts.every(
          (context) =>
            context.sessionKey === canonicalSessionKey(fixture, threadId) &&
            (surface !== "slack" || context.deliveryContext?.threadId === threadId),
        ),
      ).toBe(true);
      expectNoIsolatedFinalization(fixture);
    },
  );

  it("rejects a native exec completion with missing trusted routing", async () => {
    const fixture = await startFixture("slack", {
      nativeExecCompletion: true,
      dropCompletionRoute: true,
    });
    await injectRootMessage(fixture, "Project-X", "Verify the native completion routing guard.");
    await waitForMessage(
      fixture,
      (message) => message.text === "NATIVE_COMPLETION_CLAIM_REJECTED",
      40_000,
    );
    expect(providerContentIncludes(fixture, "Exec completed (")).toBe(true);
    expect(providerContentIncludes(fixture, "unsupportedContext:")).toBe(true);
    expect([...providerClaimResults(fixture).values()]).toEqual(["claimed", "error"]);
    expect(outboundMessages(fixture, "NATIVE_COMPLETION_REPORTED")).toHaveLength(0);
  });

  it.each(["slack", "discord"] as const)(
    "keeps a claimed %s seed silent while awaiting a human answer",
    async (surface) => {
      const fixture = await startFixture(surface, { silenceAfterClaim: true });
      const inbound = await injectRootMessage(
        fixture,
        "Project-X",
        "Start a task that needs a human answer.",
      );
      await waitForHandoffSettlement(
        fixture,
        inbound.message.id,
        "Start a task that needs a human answer.",
      );
      expect(
        fixture.bus.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => message.text),
      ).toEqual([STARTER]);
    },
  );

  it.each(["slack", "discord"] as const)(
    "ends a mentioning %s channel turn silently on its starter",
    async (surface) => {
      const fixture = await startFixture(surface, {
        answerFinalizer: true,
        silenceAfterClaim: true,
      });
      const inbound = await injectRootMessage(fixture, "Project-X", `${BOT_MENTION} start a task.`);
      await waitForHandoffSettlement(fixture, inbound.message.id, `${BOT_MENTION} start a task.`);

      expect(providerContentIncludes(fixture, '"status": "queued"')).toBe(true);
      expect(providerContentIncludes(fixture, TAKEOVER_MESSAGE)).toBe(true);
      expect(await handoffStates(fixture)).toEqual(["claimed"]);
      const snapshot = fixture.bus.state.getSnapshot();
      const expectedThreadId =
        surface === "slack"
          ? snapshot.messages.find((message) => message.direction === "inbound")?.id
          : snapshot.threads[0]?.id;
      expect(expectedThreadId).toBeTruthy();
      expect(
        allOutbound(fixture).map((message) => [
          message.text,
          message.conversation.id,
          message.threadId,
        ]),
      ).toEqual([[STARTER, "Project-X", expectedThreadId]]);
      expectNoIsolatedFinalization(fixture);
    },
  );

  it("posts the isolated finalizer into a Discord thread created with its starter", async () => {
    const fixture = await startFixture("discord", {
      answerFinalizer: true,
      starterInThreadCreate: true,
    });
    await injectRootMessage(fixture, "Project-X", `${BOT_MENTION} start a task.`);
    const finalizer = await waitForMessage(fixture, (message) =>
      message.text.includes(FINALIZER_ANSWER),
    );
    const threadId = fixture.bus.state.getSnapshot().threads[0]?.id;
    expect(threadId).toBeTruthy();
    expect(finalizer.threadId).toBe(threadId);
    expect(allOutbound(fixture).map((message) => message.threadId)).toEqual([threadId, threadId]);
  });

  it.each(["slack", "discord"] as const)(
    "starts and continues the canonical %s thread without a human nudge",
    async (surface) => {
      const fixture = await startFixture(surface, { duplicateStart: true });
      const inspection = await runOpenClaw(fixture, [
        "plugins",
        "inspect",
        "alignfirst-service",
        "--json",
        "--runtime",
      ]);
      expect(inspection).toContain('"origin": "config"');
      expect(inspection).toContain('"status": "loaded"');

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
      ) as Array<HandoffObservation & { parentConversationId: string; accountId: string }>;
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
      expect(records[0].targetSessionKey).toBe(canonicalSessionKey(fixture, expectedThreadId));
      requireClaimOwnership(fixture.root, records);
      expect(providerContentIncludes(fixture, '"status": "queued"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "claimed"')).toBe(true);
      expect(providerContentIncludes(fixture, '"status": "alreadyStarted"')).toBe(true);
      expect(providerContentIncludes(fixture, TAKEOVER_MESSAGE)).toBe(true);
      expect(providerToolCallIncludes(fixture, "message", { action: "read" })).toBe(true);
      expect(providerToolCallIncludes(fixture, "thread_handoff", { action: "claim" }, true)).toBe(
        true,
      );
      expect(
        surface === "slack"
          ? providerContentIncludes(fixture, '"receipt"') &&
              providerContentIncludes(fixture, '"deliveryStatus"')
          : providerContentIncludes(fixture, '"parentMessageId"') &&
              providerToolCallIncludes(fixture, "message", { action: "thread-reply" }),
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
      expect(allOutbound(fixture).filter((message) => message.threadId === undefined)).toEqual([]);
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
    },
  );

  it.each(["slack", "discord"] as const)(
    "delivers a %s human message sent while the seed turn runs",
    async (surface) => {
      const seedGate = createProviderGate();
      const options: FixtureOptions = { seedGate };
      const fixture = await startFixture(surface, options);
      const rootMessage = await injectRootMessage(fixture, "Project-X", "Start, reply mid-seed.");
      await waitUntil(
        () => {
          assertProviderHealthy(fixture);
          return seedGate.entered;
        },
        20_000,
        () => `the seed turn did not enter its response gate\n${diagnostics(fixture)}`,
      );
      const threadId =
        surface === "slack"
          ? rootMessage.message.id
          : fixture.bus.state.getSnapshot().threads[0]?.id;
      if (!threadId) throw new Error("native thread ID was not observed");

      const human = await injectQaBusInboundMessage({
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
      await waitUntil(
        () => dispatchObserved(fixture, "start", human.message.id),
        20_000,
        () => `Human inbound did not reach gateway while seed held\n${diagnostics(fixture)}`,
      );
      expect(seedGate.released).toBe(false);
      seedGate.release();
      await waitForHandoffSettlement(fixture, rootMessage.message.id, "Start, reply mid-seed.");
      await waitForMessage(fixture, (message) => message.text === MARKER);
      const handled = await waitForMessage(
        fixture,
        (message) => message.text === HUMAN_DURING_SEED_HANDLED,
        30_000,
      );
      expect(handled.threadId).toBe(threadId);
      await waitUntil(
        () => dispatchObserved(fixture, "done", human.message.id),
        20_000,
        () => `Human dispatch did not settle\n${diagnostics(fixture)}`,
      );
    },
  );

  it.each(["slack", "discord"] as const)(
    "keeps a repeated %s claim idempotent inside the seed turn",
    async (surface) => {
      const fixture = await startFixture(surface, { claimTwice: true });
      const inbound = await injectRootMessage(
        fixture,
        "Project-X",
        "Start a task and claim it twice.",
      );
      await waitForMessage(fixture, (message) => message.text === MARKER);
      await waitForHandoffSettlement(
        fixture,
        inbound.message.id,
        "Start a task and claim it twice.",
      );
      const claimResults = providerClaimResults(fixture);
      expect(claimResults.size).toBe(2);
      expect([...claimResults.values()]).toEqual(["claimed", "claimed"]);
      const claims = observedClaims(fixture.root);
      expect(new Set(claims.map((claim) => claim.toolCallId)).size).toBe(2);
      expect(new Set(claims.map((claim) => claim.runId)).size).toBe(1);
      requireClaimOwnership(fixture.root, await handoffRecords(fixture), claims);
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
    "starts two concurrent %s handoffs behind a running sibling turn",
    async (surface) => {
      const siblingGate = createProviderGate();
      const options: FixtureOptions = { siblingGate };
      const fixture = await startFixture(surface, options);
      const sibling = await injectRootMessage(fixture, "Project-X", "Keep this turn busy.");
      await waitUntil(
        () => {
          assertProviderHealthy(fixture);
          return siblingGate.entered;
        },
        20_000,
        () =>
          `the sibling turn did not enter its response gate; provider requests: ${fixture.providerLog.length}\n${diagnostics(fixture)}`,
      );
      await Promise.all([
        injectRootMessage(fixture, "Project-Y", "Start task Y."),
        injectRootMessage(fixture, "Project-Z", "Start task Z."),
      ]);
      await waitUntil(
        () => {
          assertProviderHealthy(fixture);
          return outboundMessages(fixture, MARKER).length === 2;
        },
        20_000,
        () => `concurrent handoffs did not finish\n${diagnostics(fixture)}`,
      );
      const records = await handoffRecords(fixture);
      expect(records.map((record) => record.state)).toEqual(["claimed", "claimed"]);
      requireClaimOwnership(fixture.root, records);
      expect(siblingGate.released).toBe(false);
      siblingGate.release();
      await waitUntil(
        () => dispatchObserved(fixture, "done", sibling.message.id),
        20_000,
        () => `Sibling dispatch did not settle\n${diagnostics(fixture)}`,
      );
    },
  );

  it.each(["slack", "discord"] as const)(
    "recovers one pending %s startup across abrupt and post-claim restarts",
    async (surface) => {
      const options = { holdFirstSeed: true };
      const fixture = await startFixture(surface, options);
      await injectRootMessage(fixture, "Project-X", "Start and survive a restart.");
      await waitUntil(
        () => {
          assertProviderHealthy(fixture);
          return fixture.providerLog.some((entry) => entry.includes(TAKEOVER_MESSAGE));
        },
        20_000,
        () => "the first pending seed was not observed",
      );
      const threadId = resolveThreadId(surface, fixture.bus.state.getSnapshot(), "Project-X");
      const pending = JSON.parse(
        await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
      ) as Array<{ state: string; targetSessionKey: string; attemptCount: number }>;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        state: "pending",
        targetSessionKey: canonicalSessionKey(fixture, threadId),
        attemptCount: 1,
      });

      options.holdFirstSeed = false;
      await restartGateway(fixture, "SIGKILL");
      const started = await waitForMessage(fixture, (message) => message.text === MARKER, 150_000);
      expect(started.threadId).toBe(threadId);
      const claimed = await handoffRecords(fixture);
      expect(claimed).toMatchObject([{ state: "claimed", attemptCount: 2 }]);
      requireClaimOwnership(fixture.root, claimed);

      await restartGateway(fixture, "SIGKILL");
      await new Promise((resolveWait) => setTimeout(resolveWait, 65_000));
      expect(outboundMessages(fixture, MARKER)).toHaveLength(1);
      const recovered = await handoffRecords(fixture);
      expect(recovered).toMatchObject([
        {
          state: "claimed",
          attemptCount: 2,
          targetSessionKey: canonicalSessionKey(fixture, threadId),
          threadId,
        },
      ]);
      requireClaimOwnership(fixture.root, recovered);
      await injectQaBusInboundMessage({
        baseUrl: serverUrl(fixture.busServer),
        input: {
          accountId: fixture.channelId,
          conversation: { kind: "channel", id: "Project-X", title: "Project-X" },
          senderId: "User-A",
          text: "Continue in this same thread.",
          threadId,
        },
      });
      const continued = await waitForMessage(
        fixture,
        (message) => message.text === "SAME_SESSION_CONTINUED",
      );
      expect(continued.threadId).toBe(threadId);
      expect(allOutbound(fixture).map((message) => message.threadId)).toEqual([
        threadId,
        threadId,
        threadId,
      ]);
      expectNoIsolatedFinalization(fixture);
    },
    300_000,
  );

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
  const owner: FixtureOwner = {
    root,
    servers: [],
    gateways: new Set(),
    handlers: new Set(),
    options,
    failures: [],
    gatewayLog: [],
    providerLog: [],
  };
  fixtures.push(owner);
  const stateDir = resolve(root, "state");
  const workspace = resolve(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "AGENTS.md"), "Use the tools exactly as requested.\n");
  const bus = createBus();
  const busServer = createServer((request, response) => {
    ownHttpHandler(owner, response, async () => {
      if (!(await bus.handler(request, response))) {
        response.statusCode = 404;
        response.end("not found");
      }
    });
  });
  owner.servers.push(busServer);
  await listen(busServer);
  const providerLog = owner.providerLog;
  const script = createProviderScript(surface, bus, options);
  owner.providerScript = script;
  const providerServer = createServer((request, response) => {
    ownHttpHandler(owner, response, () =>
      handleProvider(request, response, script.reply, providerLog),
    );
  });
  owner.servers.push(providerServer);
  await listen(providerServer);
  const channelId = `${surface}-mock`;
  const configPath = resolve(root, "openclaw.json");
  const handoffPluginPath = options.nativeExecCompletion
    ? await createContextObserver(root, options)
    : undefined;
  const passiveObserverPath = await createPassiveObserver(root);
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
        handoffPluginPath,
        passiveObserverPath,
      }),
      null,
      2,
    )}\n`,
  );
  const gatewayLog = owner.gatewayLog;
  const gateway = await launchGateway(configPath, stateDir, gatewayPort, gatewayLog, owner);
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
    owner,
  };
  return fixture;
}

function ownHttpHandler(
  owner: FixtureOwner,
  response: ServerResponse,
  operation: () => Promise<void>,
): void {
  const handler = operation()
    .catch((error) => {
      owner.failures.push(error);
      if (!response.headersSent) response.writeHead(400);
      response.end("fixture rejected request");
    })
    .finally(() => owner.handlers.delete(handler));
  owner.handlers.add(handler);
}

async function createPassiveObserver(root: string): Promise<string> {
  const observer = resolve(root, "passive-observer");
  await mkdir(observer);
  await writeObserverPackage(observer);
  await writeFile(
    resolve(observer, "openclaw.plugin.json"),
    JSON.stringify({
      id: "handoff-test-observer",
      name: "Passive handoff test observer",
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  await writeFile(
    resolve(observer, "index.js"),
    `
import { appendFileSync } from "node:fs";
export default { id: "handoff-test-observer", register(api) {
  for (const phase of ["before", "after"]) {
    api.on(phase + "_tool_call", (event, context) => {
      const { sessionKey, sessionId, runId, toolCallId } = context;
      const record = JSON.stringify({
        phase, sessionKey, sessionId, runId, toolCallId,
        toolName: event.toolName, params: event.params, result: event.result, error: event.error,
      });
      if (Buffer.byteLength(record) > 1024 * 1024) throw new Error("Tool observation exceeds 1 MiB");
      appendFileSync(${JSON.stringify(resolve(root, "tool-observations.jsonl"))}, record + "\\n");
    });
  }
}};
`,
  );
  return observer;
}

async function writeObserverPackage(observer: string): Promise<void> {
  await writeFile(
    resolve(observer, "package.json"),
    JSON.stringify({ type: "module", openclaw: { extensions: ["./index.js"] } }),
  );
}

async function createContextObserver(root: string, options: FixtureOptions): Promise<string> {
  const pluginRoot = resolve(
    PACKED_ROOT ?? REPO_ROOT,
    PACKED_ROOT === undefined
      ? "packages/service-openclaw-plugin"
      : "node_modules/@alignfirst/service-openclaw-plugin",
  );
  const observer = resolve(root, "context-observer");
  await mkdir(observer);
  await writeObserverPackage(observer);
  await writeFile(
    resolve(observer, "openclaw.plugin.json"),
    await readFile(resolve(pluginRoot, "openclaw.plugin.json")),
  );
  await writeFile(
    resolve(observer, "index.js"),
    `
import { appendFileSync } from "node:fs";
import plugin from ${JSON.stringify(resolve(pluginRoot, "dist/index.js"))};
export default { ...plugin, register(api) {
  plugin.register({ ...api, registerTool(tool, options) {
    api.registerTool(typeof tool !== "function" ? tool : (context) => {
      const { agentId, sessionKey, sessionId, messageChannel, nativeChannelId,
        agentAccountId, deliveryContext } = context;
      appendFileSync(${JSON.stringify(resolve(root, "tool-contexts.jsonl"))}, JSON.stringify({
        agentId, sessionKey, sessionId, messageChannel, nativeChannelId,
        agentAccountId, deliveryContext,
      }) + "\\n");
      const dropRoute = ${options.dropCompletionRoute === true} &&
        nativeChannelId === undefined && deliveryContext?.to !== undefined;
      return tool(dropRoute ? { ...context, deliveryContext: undefined } : context);
    }, options);
  }});
}};
`,
  );
  return observer;
}

function buildConfig(params: {
  surface: Surface;
  channelId: string;
  workspace: string;
  busUrl: string;
  providerUrl: string;
  gatewayPort: number;
  handoffPluginPath?: string;
  passiveObserverPath: string;
}) {
  return {
    gateway: { mode: "local", port: params.gatewayPort, auth: { mode: "none" } },
    update: { checkOnStart: false },
    plugins: {
      allow: [params.channelId, "alignfirst-service", "handoff-test-observer"],
      load: {
        paths: [
          params.passiveObserverPath,
          resolve(
            PACKED_ROOT ?? REPO_ROOT,
            PACKED_ROOT === undefined
              ? `packages/openclaw-${params.surface}-mock`
              : `node_modules/@alignfirst/openclaw-${params.surface}-mock`,
          ),
          params.handoffPluginPath ??
            resolve(
              PACKED_ROOT ?? REPO_ROOT,
              PACKED_ROOT === undefined
                ? "packages/service-openclaw-plugin"
                : "node_modules/@alignfirst/service-openclaw-plugin",
            ),
        ],
      },
      entries: {
        [params.channelId]: { enabled: true },
        "handoff-test-observer": { enabled: true },
        "alignfirst-service": {
          enabled: true,
          config: { channelSurfaces: { [params.channelId]: params.surface } },
        },
      },
      slots: { memory: "none" },
    },
    messages: { groupChat: { mentionPatterns: [BOT_MENTION] } },
    tools: {
      profile: "coding",
      alsoAllow: ["message", "thread_handoff"],
      toolSearch: false,
      codeMode: false,
    },
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
        silentReply: { group: "allow" },
        blockStreamingDefault: "on",
        blockStreamingBreak: "text_end",
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

async function handleProvider(
  request: IncomingMessage,
  response: ServerResponse,
  script: (body: Record<string, unknown>) => ProviderReply,
  providerLog: string[],
) {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    throw new Error(`Unexpected provider request: ${request.method} ${request.url}`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Scripted provider request exceeds 1 MiB");
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  providerLog.push(JSON.stringify(body));
  const next = script(body);
  if (next.gate) await next.gate.hold();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = next.id;
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

async function waitForHandoffSettlement(fixture: Fixture, inboundId: string, parentPrompt: string) {
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      return (
        observedClaims(fixture.root).some((claim) => claimStatus(claim) === "claimed") &&
        toolObservations(fixture.root).some(
          (event) =>
            event.phase === "after" &&
            event.toolName === "thread_handoff" &&
            event.params.action === "start" &&
            event.result?.details?.status === "queued",
        )
      );
    },
    20_000,
    () => `Seed claim and parent start hooks not observed\n${diagnostics(fixture)}`,
  );
  const records = await handoffRecords(fixture);
  expect(records).toHaveLength(1);
  const record = records[0];
  const claims = observedClaims(fixture.root);
  requireClaimOwnership(fixture.root, records, claims);
  const seed = claims.find(
    (claim) => claim.sessionKey === record.targetSessionKey && claimStatus(claim) === "claimed",
  );
  const parent = toolObservations(fixture.root).find(
    (event) =>
      event.phase === "before" &&
      event.toolName === "thread_handoff" &&
      event.params.action === "start" &&
      event.params.threadId === record.threadId,
  );
  if (!seed || !parent) throw new Error("Missing exact parent/seed run identities");
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      return (
        successfulRun(fixture.stateDir, parent, parentPrompt) &&
        successfulRun(fixture.stateDir, seed, TAKEOVER_MESSAGE) &&
        dispatchObserved(fixture, "done", inboundId) &&
        fixture.gatewayLog
          .join("")
          .includes(
            `thread-handoff ${record.handoffId} start attempt ${record.attemptCount} completed`,
          )
      );
    },
    30_000,
    () =>
      `Parent/seed runs and dispatches did not settle (${parent.runId}, ${seed.runId})\n${diagnostics(fixture)}`,
  );
}

function dispatchObserved(fixture: Fixture, phase: "start" | "done", id: string): boolean {
  return fixture.gatewayLog
    .join("")
    .includes(`inbound dispatch ${phase} id=${id}${phase === "start" ? " thread=" : "\n"}`);
}

function diagnostics(fixture: Fixture): string {
  return fixture.gatewayLog.join("").slice(-16_000);
}

function assertProviderHealthy(fixture: Fixture): void {
  if (fixture.owner.failures.length > 0)
    throw new AggregateError(fixture.owner.failures, "Scripted provider failed");
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
      assertProviderHealthy(fixture);
      found = fixture.bus.state.getSnapshot().messages.find(predicate);
      return found !== undefined;
    },
    timeoutMs,
    () =>
      `message not observed; provider requests: ${fixture.providerLog.length}\n` +
      `gateway log:\n${diagnostics(fixture)}`,
  );
  if (!found) throw new Error("message wait ended without a match");
  return found;
}

function allOutbound(fixture: Fixture) {
  return fixture.bus.state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound");
}

function expectNoIsolatedFinalization(fixture: Fixture) {
  expect(
    allOutbound(fixture).filter(
      (message) =>
        message.text.includes(FINALIZER_ANSWER) || message.text.includes(FINALIZER_FALLBACK),
    ),
  ).toEqual([]);
}

function outboundMessages(fixture: Fixture, text: string) {
  return fixture.bus.state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound" && message.text === text);
}

function canonicalSessionKey(fixture: Fixture, threadId: string): string {
  return fixture.surface === "slack"
    ? `agent:main:${fixture.channelId}:channel:project-x:thread:${threadId.toLowerCase()}`
    : `agent:main:${fixture.channelId}:channel:${threadId.toLowerCase()}`;
}

async function handoffRecords(fixture: Fixture): Promise<HandoffObservation[]> {
  return JSON.parse(await runOpenClaw(fixture, ["thread-handoff", "list", "--json"]));
}

async function handoffStates(fixture: Fixture): Promise<string[]> {
  return (await handoffRecords(fixture)).map((record) => record.state);
}

function providerToolCallIncludes(
  fixture: Fixture,
  name: string,
  expected: Record<string, unknown>,
  exact = false,
): boolean {
  return fixture.providerLog.some((entry) => {
    const body = JSON.parse(entry) as {
      messages?: Array<{
        tool_calls?: Array<{ function: { name: string; arguments: string } }>;
      }>;
    };
    return body.messages?.some((message) =>
      message.tool_calls?.some((call) => {
        if (call.function.name !== name) return false;
        const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        return (
          (!exact || Object.keys(input).length === Object.keys(expected).length) &&
          Object.entries(expected).every(([key, value]) => input[key] === value)
        );
      }),
    );
  });
}

function providerContentIncludes(fixture: Fixture, expected: string) {
  return fixture.providerLog.some((entry) => {
    const body = JSON.parse(entry) as { messages?: Array<{ content?: unknown }> };
    return body.messages?.some(
      (message) => typeof message.content === "string" && message.content.includes(expected),
    );
  });
}

function providerClaimResults(fixture: Fixture): Map<string, string> {
  return new Map(
    observedClaims(fixture.root).map((claim) => [
      `${claim.sessionId}/${claim.runId}/${claim.toolCallId}`,
      claimStatus(claim),
    ]),
  );
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
  fixture.owner.providerScript?.restart();
  fixture.gatewayLog.push(`\n--- gateway restart after ${signal} ---\n`);
  fixture.gateway = await launchGateway(
    fixture.configPath,
    fixture.stateDir,
    fixture.gatewayPort,
    fixture.gatewayLog,
    fixture.owner,
  );
}

async function launchGateway(
  configPath: string,
  stateDir: string,
  port: number,
  gatewayLog: string[],
  owner: FixtureOwner,
) {
  const readyOffset = gatewayLog.length;
  const gateway = spawn(OPENCLAW, ["gateway", "--port", String(port), "--verbose"], {
    cwd: REPO_ROOT,
    env: buildOpenClawEnv(configPath, stateDir),
    stdio: "pipe",
  });
  observeGateway(gateway);
  owner.gateways.add(gateway);
  gateway.stdout.on("data", (chunk) => gatewayLog.push(String(chunk)));
  gateway.stderr.on("data", (chunk) => gatewayLog.push(String(chunk)));
  await waitUntil(
    () => {
      if (owner.failures.length > 0)
        throw new AggregateError(owner.failures, "Fixture request failed");
      if (gateway.exitCode !== null || gateway.signalCode !== null)
        throw new Error("Gateway exited before readiness");
      return gatewayLog.slice(readyOffset).join("").includes("thread-handoff persistence ready");
    },
    30_000,
    () => `gateway did not become ready:\n${gatewayLog.slice(readyOffset).join("").slice(-16_000)}`,
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
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function buildOpenClawEnv(configPath: string, stateDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      /^(?:OPENCLAW_|OPENAI_|ANTHROPIC_|OPENROUTER_|AZURE_|AWS_|BEDROCK_|GOOGLE_|GEMINI_|ZAI_|Z_AI_|XAI_|GROQ_|MISTRAL_|COHERE_|DEEPSEEK_|TOGETHER_|FIREWORKS_|CLOUDFLARE_|MINIMAX_|MOONSHOT_|QWEN_|COPILOT_|OLLAMA_|LITELLM_|FAKE_|VITEST)/u.test(
        name,
      ) ||
      /(?:API_KEY|BASE_URL|PROXY)$/iu.test(name) ||
      ["NODE_OPTIONS", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"].includes(name)
    )
      delete env[name];
  }
  return {
    ...env,
    PATH: `${resolve(REPO_ROOT, "node_modules/.bin")}:${env.PATH ?? ""}`,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_NO_UPDATE_CHECK: "1",
    OPENCLAW_TRAJECTORY: "1",
    HOME: resolve(stateDir, ".."),
    XDG_CONFIG_HOME: resolve(stateDir, "../config"),
    XDG_STATE_HOME: resolve(stateDir, "../xdg-state"),
    XDG_CACHE_HOME: resolve(stateDir, "../cache"),
  };
}

async function stopFixture(owner: FixtureOwner) {
  const failures = [...owner.failures];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  owner.options.seedGate?.release();
  owner.options.siblingGate?.release();
  for (const gateway of owner.gateways) await attempt(() => killGateway(gateway, "SIGTERM"));
  for (const server of [...owner.servers].reverse()) await attempt(() => closeServer(server));
  await attempt(() =>
    boundedCleanup(Promise.all([...owner.handlers]), "Provider handlers did not settle"),
  );
  await attempt(() => writeFile(resolve(owner.root, "gateway.log"), owner.gatewayLog.join("")));
  await attempt(() =>
    writeFile(resolve(owner.root, "provider-requests.jsonl"), `${owner.providerLog.join("\n")}\n`),
  );
  failures.push(...owner.failures.filter((error) => !failures.includes(error)));
  if (failures.length > 0)
    throw new AggregateError(failures, `Fixture retained after cleanup failure: ${owner.root}`);
  if (process.env.KEEP_THREAD_HANDOFF_ARTIFACTS !== "1") await rm(owner.root, { recursive: true });
}

async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await boundedCleanup(
    new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections();
    }),
    "Fixture HTTP server did not close",
  );
}

async function boundedCleanup<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serverUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function reservePort() {
  const server = createServer();
  try {
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve port");
    return address.port;
  } finally {
    await closeServer(server);
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number, error: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(error());
}
