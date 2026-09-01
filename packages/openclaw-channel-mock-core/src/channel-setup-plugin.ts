import { createChannelMockAccountHelpers } from "./accounts.js";
import { createChannelMockMeta } from "./channel-meta.js";
import { buildChannelMockConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { createApplyChannelMockSetup } from "./setup.js";
import type { CoreConfig, ResolvedChannelMockAccount } from "./types.js";

export function createChannelMockSetupPlugin(params: {
  channelId: string;
  label: string;
}): ChannelPlugin<ResolvedChannelMockAccount> {
  const { channelId, label } = params;
  const meta = createChannelMockMeta({ channelId, label });
  const helpers = createChannelMockAccountHelpers({ channelId });
  const applySetup = createApplyChannelMockSetup({ channelId });
  const configSchema = buildChannelMockConfigSchema(channelId);

  return {
    id: channelId,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    reload: { configPrefixes: [`channels.${channelId}`] },
    configSchema,
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applySetup({ cfg, accountId, input: input as Record<string, unknown> }),
    },
    config: {
      listAccountIds: (cfg) => helpers.listAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => helpers.resolveDefaultAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        helpers.resolveAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
    },
  };
}
