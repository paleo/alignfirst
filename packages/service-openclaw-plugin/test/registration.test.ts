import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerThreadHandoff } from "../src/thread-handoff/index.js";
import { createHandoffStore } from "../src/thread-handoff/state.js";
import { handoff, temporaryStateDir } from "./helpers.js";

const SOURCE_CONTEXT: OpenClawPluginToolContext = {
  agentId: "main",
  sessionKey: "agent:main:slack:channel:C1",
  sessionId: "source-uuid",
  messageChannel: "slack",
  agentAccountId: "workspace-1",
  nativeChannelId: "C1",
};
const THREAD_CONTEXT: OpenClawPluginToolContext = {
  ...SOURCE_CONTEXT,
  sessionKey: "agent:main:slack:channel:C1:thread:100.200",
  sessionId: "target-uuid",
};

// OpenClaw 2026.9.8 builds a turn's tools from one registration and runs its tool hooks in another.
describe("thread handoff across two registrations in one process", () => {
  it("records a receipt observed by a hook of the other registration", () => {
    const stateDir = temporaryStateDir();
    const toolOwner = register(stateDir);
    const hookOwner = register(stateDir);
    toolOwner.createTool(SOURCE_CONTEXT);

    hookOwner.emit(
      "after_tool_call",
      {
        toolName: "message",
        params: {
          action: "send",
          target: "channel:C1",
          threadId: "100.200",
          message: "Please do the work.",
        },
        toolCallId: "tool-1",
        result: {
          details: {
            result: { target: { kind: "channel", id: "C1" }, messageId: "100.201" },
            deliveryStatus: "sent",
            messageDelivery: { status: "settled", partialDelivery: false },
          },
        },
      },
      { sessionKey: SOURCE_CONTEXT.sessionKey, sessionId: SOURCE_CONTEXT.sessionId },
    );

    const store = createHandoffStore(stateDir);
    expect(store.listReceipts(Date.now())).toMatchObject([{ threadId: "100.200" }]);
    store.close();
  });

  it("claims with the run ID remembered by a hook of the other registration", async () => {
    const stateDir = temporaryStateDir();
    const store = createHandoffStore(stateDir);
    store.insertHandoff(handoff());
    const toolOwner = register(stateDir);
    const hookOwner = register(stateDir);

    hookOwner.emit(
      "before_tool_call",
      { toolName: "thread_handoff", params: { action: "claim" } },
      {
        sessionKey: THREAD_CONTEXT.sessionKey,
        sessionId: THREAD_CONTEXT.sessionId,
        runId: "run-1",
      },
    );
    await toolOwner.createTool(THREAD_CONTEXT).execute("claim-1", { action: "claim" });

    expect(store.findHandoffByRoute("route-1")?.claimedBy).toEqual({
      sessionId: "target-uuid",
      runId: "run-1",
    });
    store.close();
  });
});

type HookHandler = (event: unknown, context: unknown) => void;

interface ToolFactoryResult {
  execute(toolCallId: string, input: unknown): Promise<unknown>;
}

function register(stateDir: string) {
  let toolFactory: ((context: OpenClawPluginToolContext) => ToolFactoryResult) | undefined;
  const hooks = new Map<string, HookHandler>();
  const api = {
    pluginConfig: { channelSurfaces: { slack: "slack" } },
    runtime: { state: { resolveStateDir: () => stateDir } },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registrationMode: "discovery",
    registerTool: (factory: (context: OpenClawPluginToolContext) => ToolFactoryResult) => {
      toolFactory = factory;
    },
    on: (name: string, handler: HookHandler) => hooks.set(name, handler),
    registerCli: vi.fn(),
  };
  // The fake carries only the members the registration reads.
  registerThreadHandoff(api as unknown as OpenClawPluginApi);
  return {
    createTool(context: OpenClawPluginToolContext): ToolFactoryResult {
      if (!toolFactory) throw new Error("thread_handoff was not registered");
      return toolFactory(context);
    },
    emit(name: string, event: unknown, context: unknown): void {
      const handler = hooks.get(name);
      if (!handler) throw new Error(`${name} hook was not registered`);
      handler(event, context);
    },
  };
}
