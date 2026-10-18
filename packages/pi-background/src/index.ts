import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import {
  type BackgroundResult,
  executeAction,
  OutputSchema,
  Parameters,
  validateInput,
} from "./background-tool.js";
import { type CompletionGuard, createCompletionGuard } from "./completion.js";
import { createRegistry, type JobRegistry, type RegistryOptions } from "./jobs.js";

export interface BackgroundOptions {
  launch?: RegistryOptions["launch"];
  beforeAcknowledge?: RegistryOptions["beforeAcknowledge"];
}

interface SessionWork {
  registry: JobRegistry;
  completion: CompletionGuard;
}

export default function background(pi: ExtensionAPI): void {
  registerBackground(pi);
}

export function registerBackground(pi: ExtensionAPI, options: BackgroundOptions = {}): void {
  let work: SessionWork | undefined;
  let runtimeId: string | undefined;
  let generation = 0;
  let replacing = false;
  const unresolved = new Set<JobRegistry>();
  const initialize = (ctx: ExtensionContext) => {
    if (replacing) throw new Error("Background lifecycle cleanup is in progress or incomplete.");
    if (work) return work;
    runtimeId ??= randomUUID();
    const registry = createRegistry({
      ...options,
      origin: { sessionId: ctx.sessionManager.getSessionId(), runtimeId, generation },
      completed: (job) => completion.complete(job),
    });
    const completion = createCompletionGuard(pi, registry, ctx);
    work = { registry, completion };
    return work;
  };
  const retire = async () => {
    replacing = true;
    if (work) unresolved.add(work.registry);
    work = undefined;
    const results = await Promise.allSettled(
      [...unresolved].map(async (registry) => {
        await registry.retire();
        unresolved.delete(registry);
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new AggregateError(
        results,
        "Background lifecycle cleanup incomplete; new launches refused.",
      );
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    if (work || unresolved.size > 0) await retire();
    replacing = false;
    initialize(ctx);
  });
  pi.on("session_shutdown", retire);
  pi.on("session_before_tree", () => {
    work?.completion.protect();
  });
  pi.on("session_tree", async (event, ctx) => {
    if (event.newLeafId === event.oldLeafId) return;
    const cleanup = retire();
    ++generation;
    await cleanup;
    replacing = false;
    initialize(ctx);
  });
  pi.on("session_before_compact", (event) => {
    if (event.reason === "manual") work?.completion.protect();
  });
  pi.on("before_agent_start", (event, ctx) => {
    const current = initialize(ctx);
    const message = event.messageType === "user" ? current.completion.recover() : undefined;
    current.completion.running();
    if (message) return { message };
  });
  pi.on("agent_start", () => {
    work?.completion.running();
  });
  pi.on("agent_settled", () => {
    work?.completion.settled();
  });
  pi.registerTool({
    name: "background",
    label: "Background",
    description:
      "Run attached, non-interactive shell commands without waiting for completion. " +
      "Actions: start, list, status, output, stop, clear. Closed stdin; no default timeout. " +
      "Never use nohup, daemonization or detachment to outlive this owner. " +
      "Eight live jobs and 32 retained records; clear terminal records to free capacity. " +
      "Output is ephemeral: 1 MiB retained, reads default 16 KiB/max 50 KiB. " +
      "Ordinary idle/busy completion requests a native follow-up; protected compaction/tree " +
      "may wait for a later user turn. Validate notice handles with status before acting.",
    parameters: Parameters,
    outputSchema: OutputSchema,
    async execute(_id, input, signal, _onUpdate, ctx): Promise<AgentToolResult<BackgroundResult>> {
      validateInput(input);
      const current = initialize(ctx);
      const data = await executeAction(input, current.registry, ctx, (request) => {
        const configured = pi.getSettings().shellPath;
        const shell = getShellConfig(
          configured?.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured,
        );
        return current.registry.start(
          request,
          {
            cwd: ctx.cwd,
            shell: shell.shell,
            args: shell.args,
            env: launchEnvironment(ctx),
          },
          signal,
        );
      });
      if (!current.registry.active())
        throw new Error("Background owner retired before returning result.");
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        details: data,
        structuredContent: data,
      };
    },
  });
}

function launchEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: "pi", PI_CODING_AGENT: "true" };
  for (const key of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
  ])
    delete env[key];
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  if (file !== undefined) env.PI_SESSION_FILE = file;
  if (ctx.model !== undefined) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel !== undefined) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}
