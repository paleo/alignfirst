import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { vi } from "vitest";
import { type BackgroundResult, OutputSchema } from "../src/background-tool.js";
import { type BackgroundOptions, registerBackground } from "../src/index.js";

export interface Response {
  text?: string;
  tool?: JsonObject;
  error?: string;
  inputTokens?: number;
}

export interface HostOptions {
  before?: ExtensionFactory[];
  after?: ExtensionFactory[];
  background?: BackgroundOptions;
  respond?: (
    request: number,
    context: TranscriptContext,
    signal?: AbortSignal,
  ) => Promise<Response> | Response;
  automaticCompaction?: boolean;
  persisted?: boolean;
  fileExtensions?: string[];
  tools?: string[];
}

export async function host(options: HostOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-background-host-"));
  const agentDir = join(cwd, "config");
  const home = join(cwd, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  const requests: TranscriptContext[] = [];
  const extensionErrors: unknown[] = [];
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected deterministic-test network request");
    }),
  );
  const provider: ExtensionFactory = (pi) => {
    pi.registerProvider("background-fixture", {
      baseUrl: "http://127.0.0.1:1",
      api: "background-fixture",
      apiKey: "local-not-a-secret",
      models: [
        {
          id: "local",
          name: "local",
          input: ["text"],
          reasoning: true,
          contextWindow: 100000,
          maxTokens: 8000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple(model, context, streamOptions) {
        requests.push(context);
        const request = requests.length;
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
          await streamOptions?.onPayload?.({ request }, model);
          await streamOptions?.onResponse?.({ status: 200, headers: {} }, model);
          const response = await abortable(
            Promise.resolve(
              options.respond?.(request, context, streamOptions?.signal) ?? { text: "ack" },
            ),
            streamOptions?.signal,
          );
          stream.push({ type: "start", partial: message });
          if (response.inputTokens !== undefined) {
            message.usage.input = response.inputTokens;
            message.usage.totalTokens = response.inputTokens + 1;
          }
          if (response.error !== undefined) throw new Error(response.error);
          if (response.tool !== undefined) {
            const toolCall = {
              type: "toolCall" as const,
              id: `call-${request}`,
              name: "background",
              arguments: response.tool,
            };
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
            message.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            const text = response.text ?? "ack";
            message.content.push({ type: "text", text });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end(message);
        })().catch((error: Error) => {
          message.stopReason = streamOptions?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = error.message;
          stream.push({ type: "error", reason: message.stopReason, error: message });
          stream.end(message);
        });
        return stream;
      },
    });
  };
  const runtime = await createAgentSessionRuntime(
    async ({ cwd: target, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: target,
        agentDir,
        settingsManager: SettingsManager.inMemory({
          defaultProvider: "background-fixture",
          defaultModel: "local",
          defaultThinkingLevel: "high",
          compaction: {
            enabled: options.automaticCompaction ?? false,
            keepRecentTokens: 1,
            reserveTokens: 10000,
          },
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noContextFiles: true,
          noThemes: true,
          additionalExtensionPaths: options.fileExtensions,
          extensionFactories: [
            provider,
            ...(options.before ?? []).map((factory, index) => ({
              name: `before-${index}`,
              factory,
            })),
            ...(options.fileExtensions === undefined
              ? [(pi: ExtensionAPI) => registerBackground(pi, options.background)]
              : []),
            ...(options.after ?? []),
          ],
          extensionsOverride: (base) => ({
            ...base,
            extensions: [
              ...base.extensions.filter((extension) =>
                extension.path.startsWith("<inline:before-"),
              ),
              ...base.extensions.filter(
                (extension) => !extension.path.startsWith("<inline:before-"),
              ),
            ],
          }),
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: options.tools ?? ["background"],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir,
      sessionManager: options.persisted
        ? SessionManager.create(cwd, join(cwd, "sessions"))
        : SessionManager.inMemory(cwd),
    },
  );
  const bind = async () => {
    await runtime.session.bindExtensions({
      mode: "json",
      onError: (error) => extensionErrors.push(error),
    });
    const model = runtime.session.modelRuntime.getModel("background-fixture", "local");
    if (model === undefined) throw new Error("Fixture provider missing.");
    await runtime.session.setModel(model);
  };
  runtime.setRebindSession(bind);
  await bind();
  return {
    cwd,
    runtime,
    requests,
    extensionErrors,
    async call(input: unknown, signal?: AbortSignal): Promise<BackgroundResult> {
      const tool = runtime.session.agent.state.tools.find((tool) => tool.name === "background");
      if (!tool) throw new Error("Public background tool missing.");
      const result = await tool.execute("test", input, signal);
      if (!Value.Check(OutputSchema, result.structuredContent))
        throw new Error(`Output schema mismatch: ${JSON.stringify(result)}`);
      expectAligned(result.content, result.structuredContent);
      return result.structuredContent;
    },
    async close() {
      await runtime.session.abort();
      await runtime.dispose();
      rmSync(cwd, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
}

function expectAligned(content: unknown, structured: unknown): void {
  if (
    JSON.stringify(content) !== JSON.stringify([{ type: "text", text: JSON.stringify(structured) }])
  ) {
    throw new Error("Text and structured background results differ.");
  }
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function waitFor(check: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture watchdog expired.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function readPidFile(path: string): Promise<number> {
  return pollFile(path, (content) => {
    const pid = content.trim();
    return /^\d+$/.test(pid) && Number(pid) > 0 ? Number(pid) : undefined;
  });
}

export function readJsonFile(path: string): Promise<unknown> {
  return pollFile(path, (content) => {
    try {
      return JSON.parse(content);
    } catch {
      return;
    }
  });
}

// Polls until the file exists and its content parses; a writer may create it before writing.
async function pollFile<T>(path: string, parse: (content: string) => T | undefined): Promise<T> {
  let value: T | undefined;
  await waitFor(() => {
    const content = readIfPresent(path);
    value = content === undefined ? undefined : parse(content);
    return value !== undefined;
  });
  if (value === undefined) throw new Error(`Missing file content: ${path}`);
  return value;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  const aborted = gate();
  const abort = () => aborted.release();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([
      promise,
      aborted.promise.then(() => {
        throw new Error("fixture aborted");
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function waitJob(
  h: { call: (input: unknown) => Promise<BackgroundResult> },
  id: string,
) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const job = jobFrom(await h.call({ action: "status", id }));
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error(`Job did not settle: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function jobFrom(result: BackgroundResult) {
  if (!("job" in result)) throw new Error("Expected a background job result.");
  return result.job;
}
