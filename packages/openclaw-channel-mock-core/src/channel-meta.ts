import type { ChannelSurface } from "./plugin-actions.js";
import type { ChannelPlugin } from "./runtime-api.js";
import type { ResolvedChannelMockAccount } from "./types.js";

/** Keep the values in lockstep with each mock package's `openclaw.channel` block. */
export function createChannelMockMeta(params: {
  channelId: string;
  label: string;
  surface: ChannelSurface;
}): ChannelPlugin<ResolvedChannelMockAccount>["meta"] {
  const { channelId, label, surface } = params;
  const surfaceLabel = surface.charAt(0).toUpperCase() + surface.slice(1);
  return {
    id: channelId,
    label,
    selectionLabel: `${label} (Synthetic)`,
    docsPath: `/channels/${channelId}`,
    blurb: `Synthetic ${surfaceLabel}-shaped transport for automated OpenClaw test scenarios.`,
  };
}
