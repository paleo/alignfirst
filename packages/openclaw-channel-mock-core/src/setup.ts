import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export function createApplyChannelMockSetup(params: { channelId: string }) {
  const { channelId } = params;
  return function applyChannelMockSetup(input: {
    cfg: OpenClawConfig;
    accountId: string;
    input: Record<string, unknown>;
  }): OpenClawConfig {
    const nextCfg = structuredClone(input.cfg) as CoreConfig;
    const section = nextCfg.channels?.[channelId] ?? {};
    const accounts = { ...section.accounts };
    const target =
      input.accountId === DEFAULT_ACCOUNT_ID ? { ...section } : { ...accounts[input.accountId] };
    if (typeof input.input.baseUrl === "string") {
      target.baseUrl = input.input.baseUrl;
    }
    if (typeof input.input.botUserId === "string") {
      target.botUserId = input.input.botUserId;
    }
    if (typeof input.input.botDisplayName === "string") {
      target.botDisplayName = input.input.botDisplayName;
    }
    nextCfg.channels ??= {};
    if (input.accountId === DEFAULT_ACCOUNT_ID) {
      nextCfg.channels[channelId] = { ...section, ...target };
    } else {
      accounts[input.accountId] = target;
      nextCfg.channels[channelId] = { ...section, accounts };
    }
    return nextCfg as OpenClawConfig;
  };
}
