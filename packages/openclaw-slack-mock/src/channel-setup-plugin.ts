import { createChannelMockSetupPlugin } from "@alignfirst/openclaw-channel-mock-core";

export const slackMockSetupPlugin = createChannelMockSetupPlugin({
  channelId: "slack-mock",
  label: "Slack Mock",
  surface: "slack",
});
