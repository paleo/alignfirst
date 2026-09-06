import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerThreadHandoffCli } from "./cli.js";
import { createReceiptCoordinator } from "./receipts.js";
import { createHandoffService } from "./service.js";
import { createHandoffStore, type HandoffStore, resolveDatabasePath } from "./state.js";
import { createThreadHandoffTool } from "./tool.js";
import type { PluginConfiguration } from "./types.js";

const configSchema = buildJsonPluginConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    channelSurfaces: {
      type: "object",
      additionalProperties: { enum: ["slack", "discord"] },
      default: { slack: "slack", discord: "discord" },
    },
  },
});

function registerThreadHandoff(api: OpenClawPluginApi): void {
  const configuration = readConfiguration(api.pluginConfig);
  let store: HandoffStore | undefined;
  const getStore = () => {
    store ??= createHandoffStore(api.runtime.state.resolveStateDir());
    return store;
  };
  const receipts = createReceiptCoordinator({ configuration, getStore, logger: api.logger });
  const service = createHandoffService({ runtime: api.runtime, getStore, logger: api.logger });

  api.registerTool(
    (context) => createThreadHandoffTool({ context, configuration, receipts, getStore, service }),
    { name: "thread_handoff", optional: true },
  );
  api.on("after_tool_call", (event, context) => {
    receipts.observe(
      {
        toolName: event.toolName,
        params: asRecord(event.params) ?? {},
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error ? { error: event.error } : {}),
      },
      context,
    );
  });
  registerThreadHandoffCli(api);
  if (api.registrationMode !== "full") return;
  api.registerService({
    id: "thread-handoff-recovery",
    async start() {
      await service.start();
      api.logger.info(
        `thread-handoff persistence ready at ${resolveDatabasePath(api.runtime.state.resolveStateDir())}`,
      );
    },
    async stop() {
      await service.stop();
      store?.close();
      store = undefined;
    },
  });
}

function readConfiguration(value: unknown): PluginConfiguration {
  const record = asRecord(value);
  const configured = asRecord(record?.channelSurfaces);
  const channelSurfaces: PluginConfiguration["channelSurfaces"] = {};
  for (const [channel, surface] of Object.entries(
    configured ?? { slack: "slack", discord: "discord" },
  )) {
    if (surface !== "slack" && surface !== "discord") {
      throw new Error(`Invalid thread-handoff surface for channel ${channel}.`);
    }
    channelSurfaces[channel] = surface;
  }
  return { channelSurfaces };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export default definePluginEntry({
  id: "thread-handoff",
  name: "Thread Handoff",
  description: "Starts regular thread sessions after confirmed native thread delivery.",
  configSchema,
  register: registerThreadHandoff,
});
