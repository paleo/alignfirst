import { createChannelMockSetupPlugin } from "@paleo/openclaw-channel-mock-core";

export const discordMockSetupPlugin = createChannelMockSetupPlugin({
  channelId: "discord-mock",
  label: "Discord Mock",
});
