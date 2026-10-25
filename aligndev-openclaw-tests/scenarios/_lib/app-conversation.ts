import { basename } from "node:path";
import type { AgentToolCall, ScenarioContext, WebchatReply } from "@alignfirst/openclaw-test";
import {
  execCommandOf,
  execMatches,
  inputOf,
  invokesAligndevCode,
  invokesCodingAgentDirectly,
} from "./agent-tool-calls.ts";
import {
  FINAL_WORKFLOW_COMPLETION_RUBRIC,
  STARTED_ACK_RUBRIC,
  waitForCodingSessionSucceeded,
} from "./coding-session.ts";
import { escapeRegExp } from "./fixture-state.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";
import { bootstrapStatusRe } from "./workspace-flow.ts";

const CHANNEL_TOOLS = ["message", "thread_handoff"];

// The guide chains the wake with `;` on the launch line; the event segment ends at the next operator.
const CHAINED_WAKE_RE = /;\s*openclaw\s+system\s+event\b([^;&|\n]*)/;
const SESSION_KEY_ARG_RE = /--session-key[=\s]+["']?([^\s"']+)/;

/** An app conversation has no channel: it calls neither `message` nor `thread_handoff`. */
export async function assertNoChannelTools(ctx: ScenarioContext): Promise<void> {
  const calls = await ctx.getAgentToolCalls();
  for (const toolName of CHANNEL_TOOLS) {
    ctx.assertLength(
      calls.filter((call) => call.toolName === toolName),
      0,
      `app conversation makes no \`${toolName}\` call`,
    );
  }
}

export interface JudgedReplyOptions {
  rubric: string;
  /** Labels the judge calls and the timeout error. */
  label: string;
  timeoutMs: number;
  /**
   * Replies an earlier wait already consumed, judged first: one reply can carry several messages,
   * such as the `[WORKSPACE]` banner and the started ack.
   */
  consumed?: WebchatReply[];
}

/**
 * Judge each new reply of the conversation against `rubric` and return the first that passes. A reply
 * that fails the judge is skipped, so a completion wake may report on either of its two turns.
 */
export async function waitForJudgedReply(
  ctx: ScenarioContext,
  sessionKey: string,
  opts: JudgedReplyOptions,
): Promise<WebchatReply> {
  const { label, timeoutMs } = opts;
  for (const reply of opts.consumed ?? []) {
    if (await judgeReply(ctx, opts, reply)) return reply;
  }
  const deadline = Date.now() + timeoutMs;
  let judged = opts.consumed?.length ?? 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let reply: WebchatReply;
    try {
      reply = await ctx.webchat.waitForReply(sessionKey, () => true, { timeoutMs: remaining });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}: no reply passed the judge among ${judged} (${reason})`);
    }
    ++judged;
    if (await judgeReply(ctx, opts, reply)) return reply;
  }
  throw new Error(`${label}: no reply passed the judge among ${judged} within ${timeoutMs}ms`);
}

async function judgeReply(
  ctx: ScenarioContext,
  opts: JudgedReplyOptions,
  reply: WebchatReply,
): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ matches: boolean; reason: string }>({
    message: reply.text,
    prompt: opts.rubric,
    returnType: '{ "matches": boolean, "reason": string }',
    label: opts.label,
  });
  const matches = parsed.matches === true;
  ctx.log({
    attachTo: reply.entry,
    label: `${opts.label}: ${matches ? "passes" : "skipped"} — ${parsed.reason}`,
  });
  return matches;
}

/**
 * The `webchat` counterpart of `settleOnWorkspaceReport`: wait for the reply that names the worktree
 * directory with the branch or the `[WORKSPACE]` tag, then assert its branch and status. Returns
 * the banner reply, which may also carry the started ack.
 */
export async function settleOnWorkspaceBanner(
  ctx: ScenarioContext,
  sessionKey: string,
  worktreeDir: string,
  branch: string,
  timeoutMs = 240_000,
): Promise<WebchatReply> {
  const locatorRe = new RegExp(escapeRegExp(basename(worktreeDir)), "i");
  const branchRe = new RegExp(`\\b${escapeRegExp(branch)}\\b`, "i");
  const banner = await ctx.webchat.waitForReply(
    sessionKey,
    ({ text }) => locatorRe.test(text) && (/\[WORKSPACE\]/.test(text) || branchRe.test(text)),
    { timeoutMs },
  );
  ctx.assertRegex(banner.text, branchRe, "workspace banner: branch name");
  ctx.assertRegex(banner.text, bootstrapStatusRe, "workspace banner: workspace status");
  return banner;
}

export interface AppDelegationChainOptions {
  sessionKey: string;
  ticketId: string;
  /** ISO timestamp taken before the request; the launch is issued after it. */
  notBefore: string;
  /** 1-based rank used in assertion labels. */
  launchIndex: number;
  /** Replies already consumed that may carry the started ack, such as the banner. */
  consumed?: WebchatReply[];
}

/**
 * The `webchat` counterpart of `expectDelegationChain`: the `aligndev code` launch chaining this
 * conversation's wake, the started ack, the `status: succeeded` session file, and the completion
 * report in the same conversation.
 */
export async function expectAppDelegationChain(
  ctx: ScenarioContext,
  opts: AppDelegationChainOptions,
): Promise<void> {
  const { sessionKey, launchIndex } = opts;
  const launch = await ctx.waitForAgentToolCall(
    (call) =>
      invokesAligndevCode(call) &&
      execMatches(call, /--protocol/) &&
      call.startedAt !== undefined &&
      call.startedAt >= opts.notBefore,
    {
      label: `agent delegates through \`aligndev code\` (launch #${launchIndex})`,
      timeoutMs: 180_000,
    },
  );
  assertChainedLaunch(ctx, launch, sessionKey, launchIndex);
  const launchStartedAt = launch.startedAt;
  if (launchStartedAt === undefined) throw new Error(`launch #${launchIndex} has no start time`);

  await waitForJudgedReply(ctx, sessionKey, {
    rubric: STARTED_ACK_RUBRIC,
    label: `background-started-ack-${launchIndex}`,
    timeoutMs: 150_000,
    consumed: opts.consumed,
  });
  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: opts.ticketId,
    timeoutMs: 120_000,
    notBefore: launchStartedAt,
  });
  ctx.log(`coding-session file #${launchIndex} succeeded: ${sessionFilePath}`);
  await waitForJudgedReply(ctx, sessionKey, {
    rubric: FINAL_WORKFLOW_COMPLETION_RUBRIC,
    label: `final-completion-report-${launchIndex}`,
    timeoutMs: 420_000,
  });
  await waitForThreadSettlement(ctx, sessionKey, launch.toolUseId);
}

function assertChainedLaunch(
  ctx: ScenarioContext,
  launch: AgentToolCall,
  sessionKey: string,
  launchIndex: number,
): void {
  if (invokesCodingAgentDirectly(launch)) {
    throw new Error(
      `launch #${launchIndex} invokes a coding agent directly: ${JSON.stringify(launch.input)}`,
    );
  }
  const input = inputOf(launch);
  ctx.assertEqual(input.background, true, `launch #${launchIndex}: runs in the background`);
  ctx.assertEqual(input.timeoutSeconds, 0, `launch #${launchIndex}: has no timeout`);
  ctx.assertEqual(
    chainedWakeKey(execCommandOf(launch) ?? ""),
    sessionKey,
    `launch #${launchIndex}: chains \`openclaw system event --mode now\` to this conversation's key`,
  );
}

function chainedWakeKey(command: string): string | undefined {
  const event = CHAINED_WAKE_RE.exec(command)?.[1];
  if (event === undefined || !/--mode[=\s]+now\b/.test(event)) return;
  return SESSION_KEY_ARG_RE.exec(event)?.[1];
}
