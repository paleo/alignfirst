import type { ChannelPlugin } from "./runtime-api.js";
import type { ResolvedChannelMockAccount } from "./types.js";

export function createChannelMockMeta(params: {
  channelId: string;
  label: string;
}): ChannelPlugin<ResolvedChannelMockAccount>["meta"] {
  const { channelId, label } = params;
  return {
    id: channelId,
    label,
    selectionLabel: label,
    docsPath: `/channels/${channelId}`,
    blurb: `Synthetic ${label} channel for automated OpenClaw test scenarios.`,
  };
}
