import type { AgentToolCall, ScenarioContext, WaitForOutboundResult } from "@paleo/openclaw-test";
import { inputOf } from "./agent-tool-calls.ts";
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

// The message-tool actions that post content (vs `read`, rename, reactions…).
const SELF_POST_ACTIONS = new Set(["send", "sendMessage", "thread-reply", "threadReply"]);

/**
 * Assert the thread-bound session never posted into its own thread via the
 * `message` tool. Its plain text auto-streams into the thread, so a
 * `send`/`thread-reply` at its own thread delivers every reply twice — the
 * duplicate-replies incident (`.plans/33/from-paleoclaw/A1-diagnostic.md`).
 * Structural detection: a call is offending when its `sessionKey` carries the
 * thread id (only the per-thread session's key does — `…-thread-<id>` on the
 * mock, `…-topic-<id>` on real Discord) AND its input targets that same
 * thread; cross-surface posts stay allowed. One-shot sweep over the flushed
 * trajectory — call it at scenario end, after the final waits resolved.
 */
export function assertNoSelfThreadMessagePost(ctx: ScenarioContext, threadId: string): void {
  const offenders = ctx
    .getAgentToolCalls()
    .filter((call) => isSelfThreadMessagePost(call, threadId));
  for (const call of offenders) {
    ctx.log(
      `thread session message-posted at its own thread: ${JSON.stringify({
        sessionKey: call.sessionKey,
        input: call.input,
      }).slice(0, 300)}`,
    );
  }
  ctx.assertLength(offenders, 0, "thread session: no message send/thread-reply at its own thread");
}

function isSelfThreadMessagePost(call: AgentToolCall, threadId: string): boolean {
  if (call.toolName !== "message") return false;
  const input = inputOf(call);
  if (typeof input.action !== "string" || !SELF_POST_ACTIONS.has(input.action)) return false;
  const needle = threadId.toLowerCase();
  if (call.sessionKey?.toLowerCase().includes(needle) !== true) return false;
  return ["threadId", "to", "target", "channelId"].some((field) => {
    const value = input[field];
    return typeof value === "string" && value.toLowerCase().includes(needle);
  });
}
