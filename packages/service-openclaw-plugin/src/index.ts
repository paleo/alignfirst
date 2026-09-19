import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CHANNEL_SURFACES, registerThreadHandoff } from "./thread-handoff/index.js";

const configSchema = buildJsonPluginConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    channelSurfaces: {
      type: "object",
      additionalProperties: { enum: ["slack", "discord"] },
      default: DEFAULT_CHANNEL_SURFACES,
    },
  },
});

export default definePluginEntry({
  id: "alignfirst-service",
  name: "AlignFirst Service",
  description: "OpenClaw capabilities for the AlignFirst Dev Kit.",
  configSchema,
  register: registerThreadHandoff,
});
