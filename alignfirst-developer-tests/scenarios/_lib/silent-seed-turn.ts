import type { ScenarioContext } from "@paleo/openclaw-test";
import { isOpenclawNotice } from "./outbound.ts";
import { expectTakeoverReaction } from "./takeover-reaction.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";
import type { Step } from "./types.ts";

/** A takeover reads the existing question and settles while awaiting the human's answer. */
export async function expectSilentSeedTurn(ctx: ScenarioContext, starter: Step): Promise<number> {
  const sessionKey = await expectTakeoverReaction(ctx, starter);
  await waitForThreadSettlement(ctx, sessionKey);
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
