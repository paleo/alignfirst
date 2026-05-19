import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-setup-plugin.js",
    exportName: "discordMockSetupPlugin",
  },
  runtime: {
    specifier: "./runtime.js",
    exportName: "setDiscordMockRuntime",
  },
});
