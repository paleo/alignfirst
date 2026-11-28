import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createBus, injectQaBusInboundMessage } from "@alignfirst/openclaw-channel-mock-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ATTEMPT_SPACING_MS } from "../../src/thread-handoff/service.js";
import { resolveDatabasePath } from "../../src/thread-handoff/state.js";
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
  findThreadId,
  mentionsConversation,
  resolveThreadId,
  starterFor,
  TAKEOVER_MESSAGE,
  FINALIZER_ANSWER,
  MARKER,
  HUMAN_DURING_SEED,
  HUMAN_DURING_SEED_HANDLED,
  type ConversationOptions,
  type ProviderReply,
  type ProviderScript,
} from "./gateway-provider.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const PACKED_ROOT = process.env.THREAD_HANDOFF_PACKED_ROOT;
const OPENCLAW = resolve(PACKED_ROOT ?? REPO_ROOT, "node_modules/.bin/openclaw");
const SURFACES = ["slack", "discord"] as const;

const BOT_MENTION = "@openclaw";

const FINALIZER_FALLBACK = "no final summary was produced";

const execFileAsync = promisify(execFile);
const testOwners: FixtureOwner[] = [];

type Surface = (typeof SURFACES)[number];
type BusMessage = ReturnType<
  ReturnType<typeof createBus>["state"]["getSnapshot"]
>["messages"][number];

interface Fixture {
  root: string;
  surface: Surface;
  channelId: string;
  bus: ReturnType<typeof createBus>;
  busServer: Server;
  script: ProviderScript;
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
  failures: unknown[];
  gatewayLog: string[];
  providerLog: string[];
  providerScript?: ProviderScript;
}

/** One test's conversation on a gateway. Its ID scopes every assertion on shared state. */
interface Project {
  fixture: Fixture;
  id: string;
}

afterEach(async () => {
  await stopOwners(testOwners);
});

describe("OpenClaw external-plugin gateway", () => {
  describe("on one shared gateway per surface", () => {
    const sharedOwners: FixtureOwner[] = [];
    const shared = new Map<Surface, Fixture>();

    beforeAll(async () => {
      const results = await Promise.allSettled(
        SURFACES.map((surface) =>
          startFixture(surface, sharedOwners, { observeToolContexts: true }),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        shared.set(result.value.surface, result.value);
      }
    });

    afterAll(async () => {
      await stopOwners(sharedOwners);
    });

    function openProject(surface: Surface, id: string, options: ConversationOptions = {}) {
      const fixture = shared.get(surface);
      if (!fixture) throw new Error(`The shared ${surface} gateway did not start`);
      return registerProject(fixture, id, options);
    }

    it.each(SURFACES)(
      "claims and delivers a %s native exec completion on its canonical thread",
      async (surface) => {
        const project = openProject(surface, `Native-${surface}`, { nativeExecCompletion: true });
        await injectMessage(project, "Start native completion verification.");
        const completed = await waitForMessage(
          project,
          (message) => message.text === "NATIVE_COMPLETION_REPORTED",
          40_000,
        );
        const threadId = projectThreadId(project);
        const sessionKey = canonicalSessionKey(project, threadId);
        expect(completed.threadId).toBe(threadId);
        expect(providerContentIncludes(project, "Exec completed (")).toBe(true);
        expect(providerContentIncludes(project, "NATIVE_EXEC_OUTPUT")).toBe(true);
        expect(claimResults(project, sessionKey)).toEqual(["claimed", "alreadyClaimed"]);
        const contexts = await projectToolContexts(project, threadId);
        expect(contexts).toContainEqual(
          expect.objectContaining({
            sessionKey,
            deliveryContext: expect.objectContaining({
              channel: project.fixture.channelId,
              to: surface === "slack" ? project.id : `channel:${threadId}`,
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
              context.sessionKey === sessionKey &&
              (surface !== "slack" || context.deliveryContext?.threadId === threadId),
          ),
        ).toBe(true);
        expectNoIsolatedFinalization(project);
      },
    );

    it("ends a mentioning Slack channel turn silently on its starter", async () => {
      const project = openProject("slack", "Silent-slack", { silenceAfterClaim: true });
      const text = `${BOT_MENTION} start a task.`;
      const inbound = await injectMessage(project, text);
      await waitForHandoffSettlement(project, inbound.message.id, text);

      expect(providerContentIncludes(project, '"status": "queued"')).toBe(true);
      expect(providerContentIncludes(project, TAKEOVER_MESSAGE)).toBe(true);
      expect(handoffStates(project)).toEqual(["claimed"]);
      expect(allOutbound(project).map((message) => [message.text, message.threadId])).toEqual([
        [starterFor(project.id), inbound.message.id],
      ]);
      expectNoIsolatedFinalization(project);
    });

    it("posts the isolated finalizer into a Discord thread created with its starter", async () => {
      const project = openProject("discord", "Finalizer-discord", {
        starterInThreadCreate: true,
      });
      await injectMessage(project, `${BOT_MENTION} start a task.`);
      const finalizer = await waitForMessage(project, (message) =>
        message.text.includes(FINALIZER_ANSWER),
      );
      const threadId = projectThreadId(project);
      expect(finalizer.threadId).toBe(threadId);
      expect(allOutbound(project).map((message) => message.threadId)).toEqual([threadId, threadId]);
    });

    it.each(SURFACES)(
      "starts and continues the canonical %s thread without a human nudge",
      async (surface) => {
        const project = openProject(surface, `Canonical-${surface}`, { duplicateStart: true });
        const { fixture } = project;
        const inspection = await runOpenClaw(fixture, [
          "plugins",
          "inspect",
          "alignfirst-service",
          "--json",
          "--runtime",
        ]);
        expect(inspection).toContain('"origin": "config"');
        expect(inspection).toContain('"status": "loaded"');

        const rootMessage = await injectMessage(project, "Start the complete task now.");
        const started = await waitForMessage(project, (message) => message.text === MARKER);
        const threadId = projectThreadId(project);
        if (surface === "slack") expect(threadId).toBe(rootMessage.message.id);
        expect(started.threadId).toBe(threadId);
        expect(outboundMessages(project, starterFor(project.id))).toHaveLength(1);
        const records = projectRecords(project);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          state: "claimed",
          threadId,
          parentConversationId: project.id,
          accountId: fixture.channelId,
          attemptCount: 1,
          claimedBy: { sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u) },
        });
        expect(records[0].targetSessionKey).toBe(canonicalSessionKey(project, threadId));
        requireClaimOwnership(fixture.root, records);
        expect(providerContentIncludes(project, '"status": "queued"')).toBe(true);
        expect(providerContentIncludes(project, '"status": "claimed"')).toBe(true);
        expect(providerContentIncludes(project, '"status": "alreadyStarted"')).toBe(true);
        expect(providerContentIncludes(project, TAKEOVER_MESSAGE)).toBe(true);
        expect(providerToolCallIncludes(project, "message", { action: "read" })).toBe(true);
        expect(providerToolCallIncludes(project, "thread_handoff", { action: "claim" }, true)).toBe(
          true,
        );
        expect(
          surface === "slack"
            ? providerContentIncludes(project, '"receipt"') &&
                providerContentIncludes(project, '"deliveryStatus"')
            : providerContentIncludes(project, '"parentMessageId"') &&
                providerToolCallIncludes(project, "message", { action: "thread-reply" }),
        ).toBe(true);

        await injectMessage(project, "Continue in this same thread.", threadId);
        const continued = await waitForMessage(
          project,
          (message) => message.text === "SAME_SESSION_CONTINUED",
        );
        expect(continued.threadId).toBe(threadId);
        expect(outboundMessages(project, MARKER)).toHaveLength(1);
        expect(allOutbound(project).filter((message) => message.threadId === undefined)).toEqual(
          [],
        );
      },
    );

    it("delivers a Slack human message sent while the seed turn runs", async () => {
      const seedGate = createProviderGate();
      const project = openProject("slack", "MidSeed-slack", { seedGate });
      const text = "Start, reply mid-seed.";
      const rootMessage = await injectMessage(project, text);
      await waitForGate(project.fixture, seedGate, "seed");
      const threadId = projectThreadId(project);

      const human = await injectMessage(project, HUMAN_DURING_SEED, threadId);
      await waitUntil(
        () => dispatchObserved(project.fixture, "start", human.message.id),
        20_000,
        () =>
          `Human inbound did not reach gateway while seed held\n${diagnostics(project.fixture)}`,
      );
      expect(seedGate.released).toBe(false);
      seedGate.release();
      await waitForHandoffSettlement(project, rootMessage.message.id, text);
      await waitForMessage(project, (message) => message.text === MARKER);
      const handled = await waitForMessage(
        project,
        (message) => message.text === HUMAN_DURING_SEED_HANDLED,
        30_000,
      );
      expect(handled.threadId).toBe(threadId);
      await waitUntil(
        () => dispatchObserved(project.fixture, "done", human.message.id),
        20_000,
        () => `Human dispatch did not settle\n${diagnostics(project.fixture)}`,
      );
    });

    it("starts two concurrent Slack handoffs behind a running sibling turn", async () => {
      const siblingGate = createProviderGate();
      const sibling = openProject("slack", "Sibling-slack", { siblingGate });
      const { fixture } = sibling;
      const projects = ["TaskY-slack", "TaskZ-slack"].map((id) => openProject("slack", id));
      const siblingRoot = await injectMessage(sibling, "Keep this turn busy.");
      await waitForGate(fixture, siblingGate, "sibling");
      await Promise.all(projects.map((project) => injectMessage(project, `Start ${project.id}.`)));
      await waitUntil(
        () => {
          assertProviderHealthy(fixture);
          return projects.every((project) => outboundMessages(project, MARKER).length === 1);
        },
        20_000,
        () => `concurrent handoffs did not finish\n${diagnostics(fixture)}`,
      );
      const ids = projects.map((project) => project.id);
      const records = handoffRecords(fixture).filter((record) =>
        ids.includes(record.parentConversationId),
      );
      expect(records.map((record) => record.state)).toEqual(["claimed", "claimed"]);
      requireClaimOwnership(fixture.root, records);
      expect(siblingGate.released).toBe(false);
      siblingGate.release();
      await waitUntil(
        () => dispatchObserved(fixture, "done", siblingRoot.message.id),
        20_000,
        () => `Sibling dispatch did not settle\n${diagnostics(fixture)}`,
      );
    });

    it("retries one failed Discord native starter without duplicating delivery", async () => {
      const project = openProject("discord", "Retry-discord");
      const { fixture } = project;
      // The bus fault is global: an earlier test's channel turn must not consume it.
      await waitForSettledDispatches(fixture);
      fixture.bus.state.failNext({
        operation: "thread-create",
        message: "planned recoverable starter failure",
      });
      await injectMessage(project, "Recover from one native delivery failure.");
      await waitForMessage(project, (message) => message.text === MARKER);
      expect(outboundMessages(project, starterFor(project.id))).toHaveLength(1);
      expect(
        fixture.bus.state
          .getSnapshot()
          .threads.filter((thread) => thread.conversationId === project.id),
      ).toHaveLength(1);
      expect(
        providerEntries(project).some((entry) =>
          entry.includes("planned recoverable starter failure"),
        ),
      ).toBe(true);
      expect(handoffStates(project)).toEqual(["claimed"]);
    });
  });

  it("recovers one pending Slack startup across abrupt and post-claim restarts", async () => {
    const fixture = await startFixture("slack", testOwners, { observeToolContexts: false });
    const options: ConversationOptions = { holdFirstSeed: true };
    const project = registerProject(fixture, "Recovery-slack", options);
    await injectMessage(project, "Start and survive a restart.");
    await waitForSeedAttempt(project, 1);
    const threadId = projectThreadId(project);
    const sessionKey = canonicalSessionKey(project, threadId);
    expect(projectRecords(project)).toMatchObject([
      { state: "pending", targetSessionKey: sessionKey, attemptCount: 1 },
    ]);

    options.holdFirstSeed = false;
    await restartGateway(fixture);
    const started = await waitForMessage(project, (message) => message.text === MARKER);
    expect(started.threadId).toBe(threadId);
    const claimed = projectRecords(project);
    expect(claimed).toMatchObject([{ state: "claimed", attemptCount: 2 }]);
    requireClaimOwnership(fixture.root, claimed);
    await waitForSeedAttempt(project, 2);

    await restartGateway(fixture);
    // Startup recovery records an attempt before "persistence ready", so a wrong restart shows here.
    const recovered = projectRecords(project);
    expect(recovered).toMatchObject([
      { state: "claimed", attemptCount: 2, targetSessionKey: sessionKey, threadId },
    ]);
    expect(outboundMessages(project, MARKER)).toHaveLength(1);
    requireClaimOwnership(fixture.root, recovered);
    const [listing, continued] = await Promise.all([
      runOpenClaw(fixture, ["thread-handoff", "list", "--json"]),
      injectMessage(project, "Continue in this same thread.", threadId).then(() =>
        waitForMessage(project, (message) => message.text === "SAME_SESSION_CONTINUED"),
      ),
    ]);
    expect(JSON.parse(listing)).toMatchObject([
      { handoffId: recovered[0].handoffId, state: "claimed", attemptCount: 2 },
    ]);
    expect(continued.threadId).toBe(threadId);
    expect(allOutbound(project).map((message) => message.threadId)).toEqual([
      threadId,
      threadId,
      threadId,
    ]);
    expectNoIsolatedFinalization(project);
  });
});

async function startFixture(
  surface: Surface,
  owners: FixtureOwner[],
  params: { observeToolContexts: boolean },
): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), `thread-handoff-${surface}-`));
  const owner: FixtureOwner = {
    root,
    servers: [],
    gateways: new Set(),
    handlers: new Set(),
    failures: [],
    gatewayLog: [],
    providerLog: [],
  };
  owners.push(owner);
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
  const script = createProviderScript(surface, bus);
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
  const handoffPluginPath = params.observeToolContexts
    ? await createContextObserver(root)
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
  return {
    root,
    surface,
    channelId,
    bus,
    busServer,
    script,
    gateway,
    gatewayPort,
    gatewayLog,
    providerLog,
    configPath,
    stateDir,
    owner,
  };
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

async function createContextObserver(root: string): Promise<string> {
  const pluginRoot = packagePath("service-openclaw-plugin");
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
      return tool(context);
    }, options);
  }});
}};
`,
  );
  return observer;
}

function packagePath(name: string): string {
  return resolve(
    PACKED_ROOT ?? REPO_ROOT,
    PACKED_ROOT === undefined ? "packages" : "node_modules/@alignfirst",
    name,
  );
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
          packagePath(`openclaw-${params.surface}-mock`),
          params.handoffPluginPath ?? packagePath("service-openclaw-plugin"),
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

function registerProject(fixture: Fixture, id: string, options: ConversationOptions): Project {
  fixture.script.register(id, options);
  return { fixture, id };
}

async function waitForHandoffSettlement(project: Project, inboundId: string, parentPrompt: string) {
  const { fixture } = project;
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      const threadId = findThreadId(fixture.surface, fixture.bus.state.getSnapshot(), project.id);
      if (threadId === undefined) return false;
      const sessionKey = canonicalSessionKey(project, threadId);
      return (
        observedClaims(fixture.root).some(
          (claim) => claim.sessionKey === sessionKey && claimStatus(claim) === "claimed",
        ) &&
        toolObservations(fixture.root).some(
          (event) =>
            event.phase === "after" &&
            event.toolName === "thread_handoff" &&
            event.params.action === "start" &&
            event.params.threadId === threadId &&
            event.result?.details?.status === "queued",
        )
      );
    },
    20_000,
    () => `Seed claim and parent start hooks not observed\n${diagnostics(fixture)}`,
  );
  const records = projectRecords(project);
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
        attemptCompleted(fixture, record.handoffId, record.attemptCount)
      );
    },
    30_000,
    () =>
      `Parent/seed runs and dispatches did not settle (${parent.runId}, ${seed.runId})\n${diagnostics(fixture)}`,
  );
}

/** A kill during a seed turn makes OpenClaw replay that turn and absorb the next message. */
async function waitForSeedAttempt(project: Project, attempt: number): Promise<void> {
  const { fixture } = project;
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      const [record] = projectRecords(project);
      return record !== undefined && attemptCompleted(fixture, record.handoffId, attempt);
    },
    20_000,
    () => `seed attempt ${attempt} did not complete\n${diagnostics(fixture)}`,
  );
}

async function waitForGate(
  fixture: Fixture,
  gate: { entered: boolean },
  turn: string,
): Promise<void> {
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      return gate.entered;
    },
    20_000,
    () => `the ${turn} turn did not enter its response gate\n${diagnostics(fixture)}`,
  );
}

async function waitForSettledDispatches(fixture: Fixture): Promise<void> {
  await waitUntil(
    () => {
      const log = fixture.gatewayLog.join("");
      const started = log.matchAll(/inbound dispatch start id=(\S+)/gu);
      return [...started].every(([, id]) =>
        new RegExp(`inbound dispatch (?:done|failed) id=${id}\\b`, "u").test(log),
      );
    },
    30_000,
    () => `Earlier inbound dispatches did not settle\n${diagnostics(fixture)}`,
  );
}

function attemptCompleted(fixture: Fixture, handoffId: string, attempt: number): boolean {
  return fixture.gatewayLog
    .join("")
    .includes(`thread-handoff ${handoffId} start attempt ${attempt} completed`);
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
  project: Project,
  predicate: (message: BusMessage) => boolean,
  timeoutMs = 20_000,
): Promise<BusMessage> {
  const { fixture } = project;
  let found: BusMessage | undefined;
  await waitUntil(
    () => {
      assertProviderHealthy(fixture);
      found = projectMessages(project).find(predicate);
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

function projectMessages(project: Project): BusMessage[] {
  return project.fixture.bus.state
    .getSnapshot()
    .messages.filter((message) => message.conversation.id === project.id);
}

function allOutbound(project: Project): BusMessage[] {
  return projectMessages(project).filter((message) => message.direction === "outbound");
}

function outboundMessages(project: Project, text: string): BusMessage[] {
  return allOutbound(project).filter((message) => message.text === text);
}

function expectNoIsolatedFinalization(project: Project) {
  expect(
    allOutbound(project).filter(
      (message) =>
        message.text.includes(FINALIZER_ANSWER) || message.text.includes(FINALIZER_FALLBACK),
    ),
  ).toEqual([]);
}

function projectThreadId(project: Project): string {
  return resolveThreadId(
    project.fixture.surface,
    project.fixture.bus.state.getSnapshot(),
    project.id,
  );
}

function canonicalSessionKey(project: Project, threadId: string): string {
  const { channelId, surface } = project.fixture;
  return surface === "slack"
    ? `agent:main:${channelId}:channel:${project.id.toLowerCase()}:thread:${threadId.toLowerCase()}`
    : `agent:main:${channelId}:channel:${threadId.toLowerCase()}`;
}

function claimResults(project: Project, sessionKey: string): string[] {
  return observedClaims(project.fixture.root)
    .filter((claim) => claim.sessionKey === sessionKey)
    .map(claimStatus);
}

async function projectToolContexts(
  project: Project,
  threadId: string,
): Promise<OpenClawPluginToolContext[]> {
  const contexts = (await readFile(resolve(project.fixture.root, "tool-contexts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line): OpenClawPluginToolContext => JSON.parse(line));
  const id = project.id.toLowerCase();
  return contexts.filter((context) =>
    [context.sessionKey, context.deliveryContext?.to].some(
      (value) =>
        value !== undefined && (value.toLowerCase().includes(id) || value.includes(threadId)),
    ),
  );
}

/** Reads the plugin's store directly: `openclaw thread-handoff list` takes about 14 s. */
function handoffRecords(fixture: Fixture): HandoffObservation[] {
  const database = new DatabaseSync(resolveDatabasePath(fixture.stateDir), { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 2000;");
    return database
      .prepare("SELECT record_json FROM handoffs ORDER BY rowid")
      .all()
      .map((row) => {
        if (typeof row.record_json !== "string") throw new Error("Invalid handoff record JSON");
        return JSON.parse(row.record_json);
      });
  } finally {
    database.close();
  }
}

function projectRecords(project: Project): HandoffObservation[] {
  return handoffRecords(project.fixture).filter(
    (record) => record.parentConversationId === project.id,
  );
}

function handoffStates(project: Project): string[] {
  return projectRecords(project).map((record) => record.state);
}

/** Provider requests of the project; each resolved its conversation from the project ID. */
function providerEntries(project: Project): string[] {
  return project.fixture.providerLog.filter((entry) => mentionsConversation(entry, project.id));
}

function providerToolCallIncludes(
  project: Project,
  name: string,
  expected: Record<string, unknown>,
  exact = false,
): boolean {
  return providerEntries(project).some((entry) => {
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

function providerContentIncludes(project: Project, expected: string) {
  return providerEntries(project).some((entry) => {
    const body = JSON.parse(entry) as { messages?: Array<{ content?: unknown }> };
    return body.messages?.some(
      (message) => typeof message.content === "string" && message.content.includes(expected),
    );
  });
}

async function injectMessage(project: Project, text: string, threadId?: string) {
  return await injectQaBusInboundMessage({
    baseUrl: serverUrl(project.fixture.busServer),
    input: {
      accountId: project.fixture.channelId,
      conversation: { kind: "channel", id: project.id, title: project.id },
      senderId: "User-A",
      senderName: "User A",
      text,
      threadId,
    },
  });
}

async function restartGateway(fixture: Fixture) {
  await killGateway(fixture.gateway);
  rewindLastAttempts(fixture.stateDir);
  fixture.script.restart();
  fixture.gatewayLog.push("\n--- gateway restart after SIGKILL ---\n");
  const restartOffset = fixture.gatewayLog.length;
  fixture.gateway = await launchGateway(
    fixture.configPath,
    fixture.stateDir,
    fixture.gatewayPort,
    fixture.gatewayLog,
    fixture.owner,
  );
  // On an existing agent database, OpenClaw rejects inbound messages until this background step ends.
  await waitUntil(
    () =>
      fixture.gatewayLog
        .slice(restartOffset)
        .join("")
        .includes("agent database recovered after background inspection and preparation"),
    30_000,
    () => `restarted gateway did not admit its agent database\n${diagnostics(fixture)}`,
  );
}

/** Makes every handoff eligible for startup recovery, as if the attempt spacing had elapsed. */
function rewindLastAttempts(stateDir: string): void {
  const database = new DatabaseSync(resolveDatabasePath(stateDir));
  try {
    database.exec("PRAGMA busy_timeout = 2000;");
    const rewind = ATTEMPT_SPACING_MS + 1_000;
    const { changes } = database
      .prepare(
        `UPDATE handoffs SET last_attempted_at = last_attempted_at - ?,
           record_json = json_replace(record_json, '$.lastAttemptedAt', last_attempted_at - ?)
         WHERE last_attempted_at IS NOT NULL`,
      )
      .run(rewind, rewind);
    if (changes !== 1) throw new Error(`Expected one attempted handoff, rewound ${changes}`);
  } finally {
    database.close();
  }
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
  const result = await execFileAsync(OPENCLAW, args, {
    cwd: REPO_ROOT,
    env: buildOpenClawEnv(fixture.configPath, fixture.stateDir),
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

async function stopOwners(owners: FixtureOwner[]): Promise<void> {
  const failures: unknown[] = [];
  while (owners.length > 0) {
    const owner = owners.pop();
    if (!owner) continue;
    try {
      await stopFixture(owner);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Gateway fixture cleanup failed");
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
  owner.providerScript?.releaseGates();
  for (const gateway of owner.gateways) await attempt(() => killGateway(gateway));
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
