import { createChannelMockPlugin } from "@paleo/openclaw-channel-mock-core";
import { getSlackMockRuntime } from "./runtime.js";

export const slackMockPlugin = createChannelMockPlugin({
  channelId: "slack-mock",
  label: "Slack Mock",
  surface: "slack",
  autoThread: true,
  getRuntime: getSlackMockRuntime,
});
