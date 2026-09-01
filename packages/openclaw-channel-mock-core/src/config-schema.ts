import {
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const ChannelMockActionConfigSchema = z
  .object({
    messages: z.boolean().optional(),
    reactions: z.boolean().optional(),
    search: z.boolean().optional(),
    threads: z.boolean().optional(),
  })
  .strict();

const ChannelMockGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema.optional(),
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
  })
  .strict();

const ChannelMockAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    botUserId: z.string().optional(),
    botDisplayName: z.string().optional(),
    pollTimeoutMs: z.number().int().min(100).max(30_000).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), ChannelMockGroupConfigSchema).optional(),
    defaultTo: z.string().optional(),
    actions: ChannelMockActionConfigSchema.optional(),
  })
  .strict();

const ChannelMockConfigSchema = ChannelMockAccountConfigSchema.extend({
  accounts: z.record(z.string(), ChannelMockAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export function buildChannelMockConfigSchema(
  _channelId: string,
): ReturnType<typeof buildChannelConfigSchema> {
  return buildChannelConfigSchema(ChannelMockConfigSchema);
}
