import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelMockAccountConfig, CoreConfig, ResolvedChannelMockAccount } from "./types.js";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;

export type ChannelMockAccountHelpers = {
  listAccountIds: (cfg: CoreConfig) => string[];
  resolveDefaultAccountId: (cfg: CoreConfig) => string;
  resolveAccount: (params: {
    cfg: CoreConfig;
    accountId?: string | null;
  }) => ResolvedChannelMockAccount;
  listEnabledAccounts: (cfg: CoreConfig) => ResolvedChannelMockAccount[];
};

export function createChannelMockAccountHelpers(params: {
  channelId: string;
}): ChannelMockAccountHelpers {
  const { channelId } = params;
  const sdkHelpers = createAccountListHelpers(channelId, {
    normalizeAccountId,
    implicitDefaultAccount: {
      channelKeys: ["baseUrl"],
    },
  });

  // For channel-mock the bus is the only endpoint; we collapse the "account" axis
  // onto the channel id so per-channel state stays partitioned on the shared bus.
  // When the config has no explicit `accounts` map, the SDK would synthesise a
  // single implicit account named "default" — we remap it to the channel id.
  function hasExplicitAccounts(cfg: CoreConfig): boolean {
    const accounts = cfg.channels?.[channelId]?.accounts;
    return Boolean(accounts && Object.keys(accounts).length > 0);
  }

  function normalizeForChannel(raw: string | null | undefined): string {
    const normalized = normalizeAccountId(raw);
    return normalized === DEFAULT_ACCOUNT_ID ? channelId : normalized;
  }

  function listAccountIds(cfg: CoreConfig): string[] {
    if (hasExplicitAccounts(cfg)) {
      return sdkHelpers.listAccountIds(cfg);
    }
    return [channelId];
  }

  function resolveDefaultAccountId(cfg: CoreConfig): string {
    if (hasExplicitAccounts(cfg)) {
      return sdkHelpers.resolveDefaultAccountId(cfg);
    }
    return channelId;
  }

  function resolveMerged(cfg: CoreConfig, accountId: string): ChannelMockAccountConfig {
    return resolveMergedAccountConfig<ChannelMockAccountConfig>({
      channelConfig: cfg.channels?.[channelId] as ChannelMockAccountConfig | undefined,
      accounts: cfg.channels?.[channelId]?.accounts,
      accountId,
      omitKeys: ["defaultAccount"],
      normalizeAccountId,
    });
  }

  function resolveAccount(params: {
    cfg: CoreConfig;
    accountId?: string | null;
  }): ResolvedChannelMockAccount {
    const accountId = hasExplicitAccounts(params.cfg)
      ? normalizeAccountId(params.accountId)
      : normalizeForChannel(params.accountId);
    const merged = resolveMerged(params.cfg, accountId);
    const baseEnabled = params.cfg.channels?.[channelId]?.enabled !== false;
    const enabled = baseEnabled && merged.enabled !== false;
    const baseUrl = merged.baseUrl?.trim() ?? "";
    const botUserId = merged.botUserId?.trim() || "openclaw";
    const botDisplayName = merged.botDisplayName?.trim() || "OpenClaw Test";
    return {
      accountId,
      enabled,
      configured: Boolean(baseUrl),
      name: normalizeOptionalString(merged.name),
      baseUrl,
      botUserId,
      botDisplayName,
      pollTimeoutMs: merged.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      config: {
        ...merged,
        allowFrom: merged.allowFrom ?? ["*"],
      },
    };
  }

  function listEnabledAccounts(cfg: CoreConfig): ResolvedChannelMockAccount[] {
    return listAccountIds(cfg)
      .map((accountId) => resolveAccount({ cfg, accountId }))
      .filter((account) => account.enabled);
  }

  return { listAccountIds, resolveDefaultAccountId, resolveAccount, listEnabledAccounts };
}

export { DEFAULT_ACCOUNT_ID };
