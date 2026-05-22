import { createChannelMockSetupPlugin } from "@paleo/openclaw-channel-mock-core";

export const slackMockSetupPlugin = createChannelMockSetupPlugin({
  channelId: "slack-mock",
  label: "Slack Mock",
});
