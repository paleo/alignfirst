import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerThreadHandoffCli } from "./cli.js";
import { createReceiptCoordinator } from "./receipts.js";
import { createRunIdCache } from "./run-ids.js";
import { createHandoffService } from "./service.js";
import { createHandoffStore, type HandoffStore, resolveDatabasePath } from "./state.js";
import { createThreadHandoffTool } from "./tool.js";
import type { PluginConfiguration } from "./types.js";
import { asRecord } from "./values.js";
import { registerWakeMethod } from "./wake.js";

export const DEFAULT_CHANNEL_SURFACES: PluginConfiguration["channelSurfaces"] = {
  slack: "slack",
  discord: "discord",
};

export function registerThreadHandoff(api: OpenClawPluginApi): void {
  const configuration = readConfiguration(api.pluginConfig);
  let store: HandoffStore | undefined;
  const getStore = () => {
    store ??= createHandoffStore(api.runtime.state.resolveStateDir());
    return store;
  };
  const receipts = createReceiptCoordinator({ configuration, getStore, logger: api.logger });
  const runIds = createRunIdCache();
  const service = createHandoffService({
    runtime: api.runtime,
    configuration,
    getStore,
    logger: api.logger,
  });

  api.registerTool(
    (context) =>
      createThreadHandoffTool({ context, configuration, receipts, runIds, getStore, service }),
    { name: "thread_handoff", optional: true },
  );
  registerWakeMethod(api, { configuration, getStore, logger: api.logger });
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
  api.on("before_tool_call", (event, context) => {
    if (event.toolName === "thread_handoff") runIds.remember(context);
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
  for (const [channel, surface] of Object.entries(configured ?? DEFAULT_CHANNEL_SURFACES)) {
    if (surface !== "slack" && surface !== "discord") {
      throw new Error(`Invalid thread-handoff surface for channel ${channel}.`);
    }
    channelSurfaces[channel] = surface;
  }
  return { channelSurfaces };
}
