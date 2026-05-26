import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "discord-mock",
  name: "Discord Mock",
  description: "Synthetic Discord-shaped test channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "discordMockPlugin",
  },
  runtime: {
    specifier: "./runtime.js",
    exportName: "setDiscordMockRuntime",
  },
});
