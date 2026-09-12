import type { ScenarioContext } from "@paleo/openclaw-test";
import { inputOf } from "./agent-tool-calls.ts";
import { isOpenclawNotice } from "./outbound.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";
import type { Step } from "./types.ts";

const CLAIM_TIMEOUT_MS = 120_000;

/** A takeover reads the existing question and settles while awaiting the human's answer. */
export async function expectSilentSeedTurn(ctx: ScenarioContext, starter: Step): Promise<number> {
  const claim = await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      call.sessionKey?.toLowerCase().includes(starter.threadId.toLowerCase()) === true,
    { label: "thread session claims its handoff", timeoutMs: CLAIM_TIMEOUT_MS },
  );
  if (claim.sessionKey === undefined) throw new Error("Handoff claim lacks session attribution");
  await ctx.waitForAgentToolCall(
    (call) =>
      call.sessionKey === claim.sessionKey &&
      call.toolName === "message" &&
      inputOf(call).action === "read",
    { label: "takeover reads thread history", timeoutMs: CLAIM_TIMEOUT_MS },
  );
  await waitForThreadSettlement(ctx, claim.sessionKey);
  const { messages, nextCursor } = await ctx.poll({
    sinceCursor: starter.nextCursor,
    timeoutMs: 1_000,
  });
  const posts = messages.filter(
    (message) =>
      message.direction === "outbound" &&
      message.threadId === starter.threadId &&
      message.id !== starter.match.id &&
      !isOpenclawNotice(message.text),
  );
  ctx.assertLength(posts, 0, "takeover waits without repeating the starter's question");
  return nextCursor;
}
