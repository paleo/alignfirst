import { pollQaBus } from "./bus-client.js";
import { handleInbound } from "./inbound.js";
import type { ChannelGatewayContext, PluginRuntime } from "./runtime-api.js";
import type { CoreConfig, ResolvedChannelMockAccount } from "./types.js";

export async function startChannelMockGatewayAccount(params: {
  channelId: string;
  channelLabel: string;
  ctx: ChannelGatewayContext<ResolvedChannelMockAccount>;
  autoThread: boolean;
  getRuntime: () => PluginRuntime;
}) {
  const { channelId, channelLabel, ctx, autoThread, getRuntime } = params;
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`${channelId} is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  try {
    while (!ctx.abortSignal.aborted) {
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      cursor = result.cursor;
      for (const event of result.events) {
        if (event.kind !== "inbound-message") {
          continue;
        }
        await handleInbound({
          channelId,
          channelLabel,
          account,
          config: ctx.cfg as CoreConfig,
          message: event.message,
          autoThread,
          getRuntime,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
  ctx.setStatus({ accountId: account.accountId, running: false });
}
