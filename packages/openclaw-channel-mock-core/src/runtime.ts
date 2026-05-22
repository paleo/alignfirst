import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

export function createChannelMockRuntimeStore(channelId: string) {
  return createPluginRuntimeStore<PluginRuntime>({
    pluginId: channelId,
    errorMessage: `${channelId} runtime not initialized`,
  });
}
