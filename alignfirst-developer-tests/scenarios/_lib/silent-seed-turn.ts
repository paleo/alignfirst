import type { ScenarioContext } from "@paleo/openclaw-test";
import { inputOf } from "./agent-tool-calls.ts";
import { isOpenclawNotice } from "./outbound.ts";
import type { Step } from "./types.ts";

// Claim latency measured on 2026-09-07: 4.5 s median, 9 s p90, outliers near 80 s in heavy cells.
const CLAIM_TIMEOUT_MS = 120_000;
// The seed turn ends well inside this window on both models; a slower turn passes vacuously.
const QUIET_WINDOW_MS = 90_000;

/**
 * The plugin starts the thread session with a seed reply run. When the starter already asked
 * the user for a missing value, the turn claims the handoff, reads no thread history, and ends on
 * the silent token. The quiet-window check is token-agnostic because a suppressed token produces
 * no outbound message. Call this after `bootstrapThreadFromChannel` and the starter judgment; it
 * returns the bus cursor after the quiet window so a caller can continue the thread.
 */
export async function expectSilentSeedTurn(ctx: ScenarioContext, starter: Step): Promise<number> {
  const claim = await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      typeof inputOf(call).handoffId === "string" &&
      isThreadSessionKey(call.sessionKey, starter.threadId),
    { label: "thread session claims the seed", timeoutMs: CLAIM_TIMEOUT_MS },
  );
  const cursor = await assertThreadStaysSilent(ctx, starter);
  const calls = await ctx.getAgentToolCalls();
  const reads = calls.filter(
    (call) =>
      call.sessionKey === claim.sessionKey &&
      call.toolName === "message" &&
      inputOf(call).action === "read",
  );
  ctx.assertLength(reads, 0, "seed turn read no thread history");
  ctx.log("seed reply run: claimed, no post, no history read — OK");
  return cursor;
}

function isThreadSessionKey(sessionKey: string | undefined, threadId: string): boolean {
  return sessionKey?.toLowerCase().includes(threadId.toLowerCase()) === true;
}

// Host notices (`⚠️ …`) are not model-controllable; they are logged and tolerated, as the
// channel-root leak sweep does.
async function assertThreadStaysSilent(ctx: ScenarioContext, starter: Step): Promise<number> {
  const deadline = Date.now() + QUIET_WINDOW_MS;
  let cursor = starter.nextCursor;
  while (Date.now() < deadline) {
    const { messages, nextCursor } = await ctx.poll({ sinceCursor: cursor, timeoutMs: 1_000 });
    cursor = nextCursor;
    for (const m of messages) {
      if (m.direction !== "outbound" || m.threadId !== starter.threadId) continue;
      if (m.id === starter.match.id) continue;
      if (isOpenclawNotice(m.text)) {
        ctx.log(`host notice in the thread tolerated: ${JSON.stringify(m.text.slice(0, 80))}`);
        continue;
      }
      throw new Error(
        `seed turn posted in the thread: ${JSON.stringify({ id: m.id, text: m.text })}`,
      );
    }
  }
  return cursor;
}
