import { createChannelMockPlugin } from "@paleo/openclaw-channel-mock-core";
import { getDiscordMockRuntime } from "./runtime.js";

export const discordMockPlugin = createChannelMockPlugin({
  channelId: "discord-mock",
  label: "Discord Mock",
  surface: "discord",
  autoThread: false,
  getRuntime: getDiscordMockRuntime,
});
