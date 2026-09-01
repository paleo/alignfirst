import type { AgentToolCall, ScenarioContext, WaitForOutboundResult } from "@paleo/openclaw-test";
import { inputOf } from "./agent-tool-calls.ts";
import {
  isMetaNarration,
  type OutboundMessage,
  waitForOutboundSkippingNarration,
} from "./meta-narration.ts";

// OpenClaw-emitted system notices (tool failures `⚠️ 🛠️ … failed`, generation
// failures `⚠️ Agent couldn't generate a response…`) stream to the channel root
// and are not model-controllable — exempt from the leak sweep.
const openclawNoticeRe = /^⚠️/u;

export interface WaitForStarterOptions {
  sinceCursor: number;
  timeoutMs?: number;
}

/**
 * Wait for the first substantive thread outbound — the starter — for this
 * conversation.
 *
 * Two provider-asymmetry tolerances (see "Auto-stream delivers turn finals only
 * on Anthropic" in `docs/alignfirst-developer/openclaw-context-engineering.md`):
 * `qwen3.7`/`glm-5.2` free-stream their mid-turn planning notes, an obedience
 * ceiling, not a regression.
 *
 * - Thread-less planning notes land on the channel root (Discord) — the same
 *   class `assertNoChannelRootLeak` tolerates. So no fail-fast on unmatched
 *   outbounds: the `threadId` predicate plus the timeout bound the wait.
 * - On Slack (auto-thread) the same notes land IN the thread, ahead of the
 *   starter — so narration-classified matches are skipped, and the wait
 *   re-enters until a substantive thread outbound arrives. A session that
 *   narrates and never posts a real starter now times out instead of failing
 *   the starter asserts on a planning note.
 */
export function waitForStarter(
  ctx: ScenarioContext,
  opts: WaitForStarterOptions,
): Promise<WaitForOutboundResult> {
  return waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    {
      // 150s: OpenClaw 2026.8 channel turns can take well over a minute before
      // the turn-end starter posts (Slack posts nothing earlier).
      timeoutMs: opts.timeoutMs ?? 150_000,
      sinceCursor: opts.sinceCursor,
      failFastUnmatchedOutbounds: false,
    },
  );
}

export interface WaitForReportOptions {
  sinceCursor: number;
  timeoutMs?: number;
}

/**
 * Wait for the status/setup report that follows the starter, skipping any
 * pre-report meta-narration. Like the starter wait, this must NOT fail-fast on
 * unmatched outbounds: weaker models free-stream planning notes to the channel
 * root before the report lands (the same class `assertNoChannelRootLeak`
 * tolerates), so `predicate` plus the timeout bound the wait instead.
 *
 * The CLI grace fail-fast is off for the same reason as `waitForSetupAck`: the
 * report turn runs mocked CLIs mid-composition (`gh`, an alcode delegation),
 * and on finals-only surfaces the report legitimately follows such a call by
 * more than any reasonable grace, with no outbound in between. The deadline
 * bounds the wait.
 */
export function waitForReport(
  ctx: ScenarioContext,
  predicate: (m: OutboundMessage) => boolean,
  opts: WaitForReportOptions,
): Promise<WaitForOutboundResult> {
  return waitForOutboundSkippingNarration(ctx, predicate, {
    timeoutMs: opts.timeoutMs ?? 180_000,
    sinceCursor: opts.sinceCursor,
    failFastCliMockGraceMs: false,
    failFastUnmatchedOutbounds: false,
  });
}

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
 * fully drained — e.g. after a `waitForAgentToolCall` assert. The transcript
 * surfaces tool calls mid-turn, so the turn may still be running then;
 * `withinMs` extends the sweep for turns that may still be streaming a final
 * answer (default 5s).
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
// The camelCase variants mirror the mock's defensive aliases (`extractToolSend`,
// `SLACK_DISABLED_ACTIONS` in `plugin-actions.ts`): the mock advertises only the
// kebab-case names, so camelCase is inert today, but we track the mock's alias
// set so a leak stays caught if it ever surfaces them.
const SELF_POST_ACTIONS = new Set(["send", "sendMessage", "thread-reply", "threadReply"]);

/**
 * Assert the thread-bound session never delivered the same reply twice — the
 * duplicate-replies incident (`.plans/33/from-paleoclaw/A1-diagnostic.md`). Its
 * plain text auto-streams into the thread, so a `send`/`thread-reply` at its own
 * thread posts that text a second time.
 *
 * The offending call is found structurally: `sessionKey` carries the thread id
 * (only the per-thread session's key does — `…-thread-<id>` on the mock,
 * `…-topic-<id>` on real Discord) and the input targets that same thread;
 * cross-surface posts stay allowed. A call whose text reached the thread exactly
 * once is not the incident, though — the playbook has the session route one line
 * through the tool when it needs a rename, and Discord offers no other way. So
 * the failure is a self-thread post whose text also arrived on its own.
 *
 * One-shot sweep over the session transcript — call it at scenario end, after
 * the final waits resolved.
 */
export async function assertNoSelfThreadMessagePost(
  ctx: ScenarioContext,
  threadId: string,
  sinceCursor = 0,
): Promise<void> {
  const calls = await ctx.getAgentToolCalls();
  const posts = calls.filter((call) => isSelfThreadMessagePost(call, threadId));
  const { messages } = await ctx.poll({ sinceCursor, timeoutMs: 1_000 });
  const threadTexts = messages
    .filter((m) => m.direction === "outbound" && m.threadId === threadId)
    .map((m) => m.text.trim());

  const duplicated = posts.filter((call) => {
    const text = readPostText(call);
    if (text === undefined) return false;
    return threadTexts.filter((t) => t === text).length > 1;
  });
  for (const call of duplicated) {
    ctx.log(
      `thread session double-posted its own reply: ${JSON.stringify({
        sessionKey: call.sessionKey,
        input: call.input,
      }).slice(0, 300)}`,
    );
  }
  if (posts.length > duplicated.length) {
    ctx.log(
      `${posts.length - duplicated.length} self-thread message post(s) delivered once — tolerated`,
    );
  }
  ctx.assertLength(duplicated, 0, "thread session: no reply delivered twice");
}

function readPostText(call: AgentToolCall): string | undefined {
  const input = inputOf(call);
  for (const field of ["message", "text", "content"]) {
    const value = input[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return;
}

function isSelfThreadMessagePost(call: AgentToolCall, threadId: string): boolean {
  if (call.toolName !== "message") return false;
  const input = inputOf(call);
  if (typeof input.action !== "string" || !SELF_POST_ACTIONS.has(input.action)) return false;
  // A rename is the one sanctioned self-thread post: Discord renames a thread
  // only through a send carrying `threadName`, so the playbook has the session
  // route one line through the tool instead of auto-streaming it.
  if (typeof input.threadName === "string" && input.threadName.trim() !== "") return false;
  const needle = threadId.toLowerCase();
  if (call.sessionKey?.toLowerCase().includes(needle) !== true) return false;
  // These are exactly the params the mock reads to aim a post: `resolveDestination`
  // (`to` → `target` → `channelId`) plus the explicit `threadId`. The `sessionKey`
  // gate above already narrows to the per-thread session, so a `channelId` that
  // happens to match a non-thread target can't produce a false positive here.
  // Substring-matched against the mock's `…-thread-<id>` / `…-topic-<id>` shapes;
  // revisit if a third channel plugin names sessions or targets differently.
  return ["threadId", "to", "target", "channelId"].some((field) => {
    const value = input[field];
    return typeof value === "string" && value.toLowerCase().includes(needle);
  });
}
