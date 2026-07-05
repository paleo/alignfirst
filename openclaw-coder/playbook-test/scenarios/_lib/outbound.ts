import type { ScenarioContext, WaitForOutboundResult } from "@paleo/openclaw-test";
import { isMetaNarration } from "./meta-narration.ts";

// OpenClaw-emitted system notices (tool failures `⚠️ 🛠️ … failed`, generation
// failures `⚠️ Agent couldn't generate a response…`) stream to the channel root
// and are not model-controllable — exempt from the leak sweep.
const openclawNoticeRe = /^⚠️/u;

/**
 * The starter and its follow-ups always arrive inside a thread. Narrow the
 * optional `threadId` for the type system, failing loudly if the bus ever
 * delivers a thread-less match.
 */
export function requireThreadId(wait: WaitForOutboundResult): string {
  const { threadId, id } = wait.match;
  if (threadId === undefined) {
    throw new Error(`expected outbound message ${id} to carry a threadId`);
  }
  return threadId;
}

/**
 * Assert the agent posted nothing substantive on the channel root since
 * `sinceCursor`. Once a thread exists, every post must carry a threadId;
 * free-form assistant text auto-streams to the parent channel (Discord), so a
 * thread-less outbound is a leak. Offenders classified as meta-narration are
 * logged and tolerated: qwen3.7 free-streams planning notes as content in a
 * material share of turns and three playbook wordings did not eliminate it —
 * an obedience ceiling, not a regression. Substantive leaks (reports,
 * duplicate summaries, improvised tokens) fail. Call it once the turn has
 * fully drained — e.g. after a `waitForAgentToolCall` assert, which resolves
 * only after the trajectory flushed at session-run end. `withinMs` extends the
 * sweep past that point for turns that may still be streaming a final answer
 * (default 5s).
 */
export async function assertNoChannelRootLeak(
  ctx: ScenarioContext,
  opts: { sinceCursor: number; withinMs?: number },
): Promise<void> {
  const deadline = Date.now() + (opts.withinMs ?? 5_000);
  let cursor = opts.sinceCursor;
  let tolerated = 0;
  do {
    const { messages, nextCursor } = await ctx.poll({ sinceCursor: cursor, timeoutMs: 1_000 });
    cursor = nextCursor;
    for (const m of messages) {
      if (m.direction !== "outbound" || m.conversation.id !== ctx.conversationId) continue;
      if (m.threadId !== undefined || openclawNoticeRe.test(m.text)) continue;
      if (await isMetaNarration(ctx, m.text)) {
        ++tolerated;
        ctx.log(`channel-root narration tolerated: ${JSON.stringify(m.text.slice(0, 80))}`);
        continue;
      }
      throw new Error(
        `substantive channel-root post leaked: ${JSON.stringify({ id: m.id, text: m.text })}`,
      );
    }
  } while (Date.now() < deadline);
  ctx.log(
    tolerated === 0
      ? "no channel-root post — OK"
      : `no substantive channel-root post — OK (${tolerated} narration tolerated)`,
  );
}
