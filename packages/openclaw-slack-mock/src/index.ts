import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "slack-mock",
  name: "Slack Mock",
  description: "Synthetic Slack-shaped test channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "slackMockPlugin",
  },
  runtime: {
    specifier: "./runtime.js",
    exportName: "setSlackMockRuntime",
  },
});
