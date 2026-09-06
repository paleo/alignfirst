type ChannelMockActionConfig = {
  messages?: boolean;
  reactions?: boolean;
  search?: boolean;
  threads?: boolean;
};

export type ChannelMockAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
  pollTimeoutMs?: number;
  allowFrom?: Array<string | number>;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      tools?: Record<string, unknown>;
      toolsBySender?: Record<string, Record<string, unknown>>;
    }
  >;
  defaultTo?: string;
  replyToMode?: "off" | "all";
  actions?: ChannelMockActionConfig;
};

export type ChannelMockConfig = ChannelMockAccountConfig & {
  accounts?: Record<string, Partial<ChannelMockAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = {
  channels?: Record<string, ChannelMockConfig | undefined>;
  session?: {
    store?: string;
  };
};

export type ResolvedChannelMockAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  botUserId: string;
  botDisplayName: string;
  pollTimeoutMs: number;
  config: ChannelMockAccountConfig;
};
