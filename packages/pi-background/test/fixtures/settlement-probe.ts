import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const action = process.argv[2];
const cwd = process.cwd();
const agentDir = join(cwd, "agent");
const entered = deferred();
const cleanup = deferred();
const workerPath = new URL("./settlement-worker.mjs", import.meta.url);
const errors: string[] = [];
const settlements: boolean[] = [];
let requests = 0;
let shutdowns = 0;
let signalAtBoundary = false;
let toolSignal: AbortSignal | undefined;
let worker: ChildProcessWithoutNullStreams | undefined;
let workerClosed: Promise<void> | undefined;
let workerPids: number[] = [];
let promptReturned = false;
let operationReturned = false;
let continuationSawResult = false;

await main();

async function main() {
  globalThis.fetch = () => {
    throw new Error("Unexpected settlement-probe network request");
  };
  const runtime = await createAgentSessionRuntime(
    async ({ cwd: target, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: target,
        agentDir,
        settingsManager: SettingsManager.inMemory({
          defaultProvider: "settlement-probe",
          defaultModel: "local",
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "off",
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noContextFiles: true,
          noThemes: true,
          extensionFactories: [registerProbe],
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: ["probe_job"],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  await runtime.session.bindExtensions({
    mode: "json",
    onError: (error) => errors.push(error.error),
  });
  const model = runtime.session.modelRuntime.getModel("settlement-probe", "local");
  if (model === undefined) throw new Error("Missing scripted model");
  await runtime.session.setModel(model);
  runtime.session.subscribe((event) => {
    if (event.type === "agent_settled") settlements.push(event.aborted);
  });
  const pending = runtime.session.prompt("Start gated work, then answer.").then(() => {
    promptReturned = true;
  });
  await entered.promise;
  // This observation period does not release the job or its cleanup gate.
  await delay(100);
  const held = snapshot();
  if (action === "control") {
    worker?.stdin.end();
    await workerClosed;
    await delay(100);
    const beforeCleanup = snapshot();
    cleanup.resolve();
    await pending;
    const final = runtime.session.getLastAssistantText();
    await runtime.dispose();
    observe({ held, beforeCleanup, final, ...snapshot() });
    return;
  }
  if (action === "failure") {
    await pending;
    observe({ held, final: runtime.session.getLastAssistantText(), ...snapshot() });
    // Keep unresolved ownership attached for the external subreaper/watchdog.
    await new Promise(() => {});
    return;
  }
  const operation =
    action === "abort"
      ? runtime.session.abort()
      : action === "new"
        ? runtime.newSession()
        : action === "switch"
          ? runtime.switchSession(writeTargetSession())
          : Promise.reject(new Error(`Unknown probe action: ${action}`));
  void operation.then(
    () => {
      operationReturned = true;
    },
    (error: Error) => errors.push(error.message),
  );
  await delay(500);
  observe({ held, ...snapshot() });
  // Never release work to make abort/replacement appear to succeed.
  await operation;
  await pending;
  await runtime.dispose();
}

function registerProbe(pi: ExtensionAPI) {
  registerProvider(pi);
  pi.registerTool({
    name: "probe_job",
    label: "Gated job",
    description: "Start the test-owned attached process tree.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      toolSignal = signal;
      worker = spawn(process.execPath, [workerPath.pathname], { stdio: "pipe" });
      workerClosed = new Promise<void>((resolve, reject) => {
        worker?.once("error", reject);
        worker?.once("close", () => resolve());
      });
      worker.stderr.resume();
      workerPids = await new Promise<number[]>((resolve, reject) => {
        worker?.stdout.once("data", (data: Buffer) => {
          try {
            resolve(JSON.parse(data.toString()));
          } catch (error) {
            reject(error);
          }
        });
        worker?.once("error", reject);
      });
      signal?.addEventListener("abort", () => void stopWork(), { once: true });
      return { content: [{ type: "text", text: "accepted" }], details: {} };
    },
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (requests !== 2) return;
    signalAtBoundary = ctx.signal !== undefined;
    ctx.signal?.addEventListener("abort", () => void stopWork(), { once: true });
    entered.resolve();
    if (action === "failure") {
      await delay(150);
      throw new Error("Injected unresolved process cleanup failure");
    }
    await workerClosed;
    await cleanup.promise;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "probe-completion",
          content: "PROBE-CLEANUP-COMPLETE",
          display: false,
        },
      ],
      continue: true,
    };
  });
  pi.on("session_shutdown", async () => {
    ++shutdowns;
    await stopWork();
  });
}

function registerProvider(pi: ExtensionAPI) {
  pi.registerProvider("settlement-probe", {
    api: "settlement-probe",
    apiKey: "local-script-only",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "local",
        name: "local",
        input: ["text"],
        reasoning: false,
        contextWindow: 100000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const request = ++requests;
      if (request > 3) throw new Error("Script exhausted; unexpected provider request");
      if (request === 3) {
        continuationSawResult = JSON.stringify(context.messages).includes("PROBE-CLEANUP-COMPLETE");
      }
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "pending",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        await options?.onPayload?.({ request }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: "start", partial: message });
        if (request === 1) {
          const toolCall = {
            type: "toolCall" as const,
            id: "probe-call",
            name: "probe_job",
            arguments: {},
          };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          const text = request === 2 ? "provisional" : "authoritative result";
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end(message);
      })().catch((error: Error) => {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = error.message;
        stream.push({ type: "error", reason: message.stopReason, error: message });
        stream.end(message);
      });
      return stream;
    },
  });
}

async function stopWork() {
  worker?.stdin.end();
  await workerClosed;
  cleanup.resolve();
}

function snapshot() {
  return {
    nativeVersion: VERSION,
    requests,
    promptReturned,
    operationReturned,
    signalAtBoundary,
    toolSignalAborted: toolSignal?.aborted,
    shutdowns,
    settlements: [...settlements],
    errors: [...errors],
    workerPids,
    continuationSawResult,
  };
}

function observe(value: unknown) {
  writeFileSync(join(cwd, "observation.json"), JSON.stringify(value));
}

function writeTargetSession() {
  const path = join(cwd, "target.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "probe-target",
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`,
  );
  return path;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
