import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, inputOf, invokesAlcode, readsFile } from "./agent-tool-calls.ts";
import { escapeRe, STARTER_HANDS_OFF_RUBRIC } from "./common-constants.ts";
import type { CodingAgentMockHandle } from "./mock-coding-agent.ts";
import { assertNoChannelRootLeak, requireThreadId, waitForStarter } from "./outbound.ts";
import { FIXTURE_PROJECT_PATHS } from "./project-fixtures.ts";
import type { Step } from "./types.ts";

const SENDER_ID = "ROBIN01";

export interface ChannelBootstrapOptions {
  /** The channel/DM message that triggers the bootstrap. */
  text: string;
  /** Asserted to appear in the starter on Discord — the fresh thread session's only carrier. */
  project?: string;
  /** Asserted as a labelled canonical path in every resolved-project starter. */
  projectPath?: string;
  /** Asserted to appear in the starter, when the channel message supplied one. */
  ticketId?: string;
  /** Asserted verbatim in the starter for a detailed request. */
  request?: string;
  codingAgent?: CodingAgentMockHandle;
  /** Worktree paths seeded before the run; anything else on disk is the channel session's. */
  seededWorktreePaths?: string[];
  starterTimeoutMs?: number;
  /** Runs immediately after native starter delivery, before waiting for the start call. */
  afterStarter?: (threadId: string) => Promise<void>;
}

/**
 * Open a thread, confirm its native starter and durable handoff, then return as
 * soon as the target session is eligible to run. Target work may already be in
 * progress before the parent turn emits its final `NO_REPLY`.
 */
export async function bootstrapThreadFromChannel(
  ctx: ScenarioContext,
  opts: ChannelBootstrapOptions,
): Promise<Step> {
  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({ senderId: SENDER_ID, senderName: SENDER_ID, text: opts.text });

  const wait = await waitForStarter(ctx, {
    sinceCursor: startCursor,
    timeoutMs: opts.starterTimeoutMs,
  });
  const threadId = requireThreadId(wait);
  ctx.log({ attachTo: wait.entry, label: `starter received in thread ${threadId}` });

  assertStarterValues(ctx, wait.match.text, opts);
  await opts.afterStarter?.(threadId);

  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: STARTER_HANDS_OFF_RUBRIC,
    label: "starter-hands-off",
  });

  const handoff = await assertChannelSessionHandedOff(ctx, {
    threadId,
    sinceCursor: wait.nextCursor,
    startCursor,
  });

  return {
    match: wait.match,
    entry: wait.entry,
    threadId,
    nextCursor: wait.nextCursor,
    sourceSessionKey: handoff.sourceSessionKey,
    targetSessionKey: handoff.targetSessionKey,
  };
}

/**
 * The starter is the thread's durable record: a fresh thread session recovers
 * the project, ticket, task and full detailed request from it, having seen
 * neither the channel message nor the thread's own name. Assert the values the
 * channel message actually supplied.
 */
function assertStarterValues(
  ctx: ScenarioContext,
  text: string,
  opts: ChannelBootstrapOptions,
): void {
  // On Discord the starter is the ONLY carrier — the channel message is the
  // thread's parent, excluded from its message list.
  if (ctx.channel === "discord-mock" && opts.project !== undefined) {
    ctx.assertRegex(
      text,
      new RegExp(escapeRe(opts.project), "i"),
      "starter names the project (thread-session recovery carrier)",
    );
  }
  if (opts.projectPath !== undefined) {
    // Content-based: labels follow the user's language, so assert the exact
    // canonical path rather than a "Project path:" line.
    ctx.assertRegex(
      text,
      new RegExp(escapeRe(opts.projectPath), "i"),
      "starter carries the canonical project path",
    );
  }
  if (opts.ticketId !== undefined) {
    ctx.assertRegex(
      text,
      new RegExp(`\\b${escapeRe(opts.ticketId)}\\b`),
      "starter states the ticket",
    );
  }
  if (opts.request !== undefined && !text.includes(opts.request)) {
    throw new Error(`starter omitted the detailed request: ${JSON.stringify(text)}`);
  }
}

interface ChannelSessionHandedOffOptions {
  threadId: string;
  sinceCursor: number;
  startCursor: number;
}

async function assertChannelSessionHandedOff(
  ctx: ScenarioContext,
  opts: ChannelSessionHandedOffOptions,
): Promise<{ sourceSessionKey: string; targetSessionKey?: string }> {
  const startCall = await ctx.waitForAgentToolCall(
    (call) => {
      const input = inputOf(call);
      return (
        call.toolName === "thread_handoff" &&
        input.action === "start" &&
        input.threadId === opts.threadId
      );
    },
    { label: "parent session starts the durable thread handoff", timeoutMs: 120_000 },
  );
  if (!startCall.sessionKey) {
    throw new Error("thread_handoff start is missing session attribution");
  }
  if (startCall.sessionKey.toLowerCase().includes(opts.threadId.toLowerCase())) {
    throw new Error(`thread_handoff start ran from the target session: ${startCall.sessionKey}`);
  }
  const calls = await ctx.getAgentToolCalls();
  const parentCalls = calls.filter((call) => call.sessionKey === startCall.sessionKey);
  const starts = parentCalls.filter((call) => {
    const input = inputOf(call);
    return call.toolName === "thread_handoff" && input.action === "start";
  });
  ctx.assertLength(starts, 1, "parent session issued exactly one handoff start");
  const starterPosts = parentCalls.filter(
    (call) => call.toolName === "message" && JSON.stringify(call.result).includes(opts.threadId),
  );
  ctx.assertLength(starterPosts, 1, "one confirmed native starter created the handoff target");
  const forbidden = parentCalls.filter(
    (call) =>
      readsFile(call, "DEVELOPERS.md") ||
      readsFile(call, "README.md") ||
      invokesAlcode(call) ||
      execMatches(call, /\b(workspace|worktree|git\s+(?:-C\s+\S+\s+)?(?:status|log|show|diff))\b/i),
  );
  ctx.assertLength(forbidden, 0, "parent session performed no target work");
  await assertNoChannelRootLeak(ctx, { sinceCursor: opts.startCursor });
  const resultText = JSON.stringify(startCall.result ?? {});
  const targetSessionKey = readJsonString(resultText, "sessionKey");
  ctx.log(`parent session handed off to ${targetSessionKey ?? opts.threadId} — OK`);
  return { sourceSessionKey: startCall.sessionKey, targetSessionKey };
}

function readJsonString(value: string, field: string): string | undefined {
  const match = new RegExp(`\\"${field}\\"\\s*:\\s*\\"([^\\"]+)\\"`).exec(value);
  return match?.[1];
}

/** Sends a user message into the thread, waking a thread session. Returns the pre-send cursor. */
export async function sendInThread(
  ctx: ScenarioContext,
  threadId: string,
  text: string,
): Promise<number> {
  const cursor = await ctx.getCursor();
  await ctx.sendInbound({ senderId: SENDER_ID, senderName: SENDER_ID, text, threadId });
  return cursor;
}

/**
 * Assert the worktree dirs on the shared projects volume are exactly `expected`
 * — the ones the fixture seeded. Anything else was created by the session under
 * test, which is how a channel session that ran setup gets caught.
 */
export function assertWorktreePaths(ctx: ScenarioContext, expected: string[]): void {
  const found = findFixtureWorktreePaths();
  const extras = found.filter((path) => !expected.includes(path));
  if (extras.length > 0) {
    throw new Error(`unexpected fixture worktree dirs: ${extras.join(", ")}`);
  }
  ctx.log(
    expected.length === 0
      ? "no worktree dirs created — OK"
      : `only the seeded worktrees present (${found.join(", ")}) — OK`,
  );
}

export function assertNoWorktreeDirs(ctx: ScenarioContext): void {
  assertWorktreePaths(ctx, []);
}

function findFixtureWorktreePaths(): string[] {
  return FIXTURE_PROJECT_PATHS.flatMap((projectPath) => {
    const parent = dirname(projectPath);
    if (!existsSync(parent)) return [];
    const prefix = `${basename(projectPath)}-`;
    return readdirSync(parent)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => `${parent}/${entry}`);
  }).sort();
}

export function assertNoCodingAgentCalls(codingAgent: CodingAgentMockHandle): void {
  if (codingAgent.codingAgentCalls.length === 0) return;
  throw new Error(
    `expected no coding-agent call; got ${codingAgent.codingAgentCalls.length}: ${JSON.stringify(
      codingAgent.codingAgentCalls.map((call) => ({ agent: call.agent, argv: call.argv })),
    )}`,
  );
}
