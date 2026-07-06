import { pollQaBus } from "./bus-client.js";
import { handleInbound } from "./inbound.js";
import type { ChannelSurface } from "./plugin-actions.js";
import type { ChannelGatewayContext, PluginRuntime } from "./runtime-api.js";
import type { CoreConfig, ResolvedChannelMockAccount } from "./types.js";

export async function startChannelMockGatewayAccount(params: {
  channelId: string;
  channelLabel: string;
  ctx: ChannelGatewayContext<ResolvedChannelMockAccount>;
  surface: ChannelSurface;
  autoThread: boolean;
  getRuntime: () => PluginRuntime;
}) {
  const { channelId, channelLabel, ctx, surface, autoThread, getRuntime } = params;
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
        // Fire-and-forget, as the real monitors do ("per-session ordering is owned
        // by the message run queue"): a long agent turn must not delay the next
        // inbound, and one bad dispatch must not kill the poll loop.
        console.log(
          `[${channelId}] inbound dispatch start id=${event.message.id} thread=${event.message.threadId ?? "-"}`,
        );
        void handleInbound({
          channelId,
          channelLabel,
          account,
          config: ctx.cfg as CoreConfig,
          message: event.message,
          surface,
          autoThread,
          getRuntime,
        })
          .then(() => console.log(`[${channelId}] inbound dispatch done id=${event.message.id}`))
          .catch((error) => {
            // Gateway shutdown rejects every in-flight turn; only silence the log noise —
            // nothing here can (or should) affect the poll loop.
            if (ctx.abortSignal.aborted) return;
            console.error(`[${channelId}] inbound dispatch failed id=${event.message.id}:`, error);
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
