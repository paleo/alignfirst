import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe, STARTER_HANDS_OFF_RUBRIC } from "./common-constants.ts";
import type { ClaudeMockHandle } from "./mock-claude.ts";
import { assertNoChannelRootLeak, requireThreadId, waitForStarter } from "./outbound.ts";
import type { Step } from "./types.ts";

const PROJECTS_DIR = "/home/claw/projects";
const SENDER_ID = "ROBIN01";

export interface ChannelBootstrapOptions {
  /** The channel/DM message that triggers the bootstrap. */
  text: string;
  /** Asserted to appear in the starter on Discord — the fresh thread session's only carrier. */
  project?: string;
  /** Asserted to appear in the starter, when the channel message supplied one. */
  ticketId?: string;
  /** Asserted as a literal `tech` / `non-tech` token in the starter. */
  audience?: "tech" | "non-tech";
  claude?: ClaudeMockHandle;
  /** Worktree dir names seeded before the run; anything else on disk is the channel session's. */
  seededWorktreeDirs?: string[];
  starterTimeoutMs?: number;
  /** How long the channel session must stay silent after the starter. */
  quietMs?: number;
}

/**
 * Drive the channel session through its whole job: open a thread carrying the
 * handoff values, then end the turn.
 *
 * Since the thread session only activates on the user's next message in the
 * thread, the starter is the channel session's single post — and everything
 * else (workspace, alcode, codebase, status) belongs to the thread session.
 * This asserts that contract structurally: one thread post, no second one, no
 * worktree on disk, no coding-agent call.
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

  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: STARTER_HANDS_OFF_RUBRIC,
    label: "starter-hands-off",
  });

  await assertChannelSessionStopped(ctx, {
    threadId,
    sinceCursor: wait.nextCursor,
    startCursor,
    quietMs: opts.quietMs,
    claude: opts.claude,
    seededWorktreeDirs: opts.seededWorktreeDirs,
  });

  return { match: wait.match, entry: wait.entry, threadId, nextCursor: wait.nextCursor };
}

/**
 * The starter is the thread's durable record: a fresh thread session recovers
 * the project, the ticket, the audience and the task from it, having seen
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
  if (opts.ticketId !== undefined) {
    ctx.assertRegex(
      text,
      new RegExp(`\\b${escapeRe(opts.ticketId)}\\b`),
      "starter states the ticket",
    );
  }
  if (opts.audience !== undefined) assertStarterAudience(text, opts.audience);
}

// The audience travels as a literal `tech` / `non-tech` token, kept intact
// across languages, so check it by token rather than by an LLM judge.
// "non-tech" contains "tech", so the tech case must also exclude it.
function assertStarterAudience(text: string, expected: "tech" | "non-tech"): void {
  const hasNonTech = /\bnon-?tech\b/i.test(text);
  if (expected === "non-tech") {
    if (!hasNonTech) {
      throw new Error(`starter audience: expected non-tech, got: ${JSON.stringify(text)}`);
    }
    return;
  }
  if (hasNonTech || !/\btech\b/i.test(text)) {
    throw new Error(`starter audience: expected tech, got: ${JSON.stringify(text)}`);
  }
}

interface ChannelSessionStoppedOptions {
  threadId: string;
  sinceCursor: number;
  startCursor: number;
  quietMs?: number;
  claude?: ClaudeMockHandle;
  seededWorktreeDirs?: string[];
}

async function assertChannelSessionStopped(
  ctx: ScenarioContext,
  opts: ChannelSessionStoppedOptions,
): Promise<void> {
  await ctx.expectNoOutbound((m) => m.direction === "outbound" && m.threadId === opts.threadId, {
    withinMs: opts.quietMs ?? 10_000,
    sinceCursor: opts.sinceCursor,
  });
  await assertNoChannelRootLeak(ctx, { sinceCursor: opts.startCursor });
  assertWorktreeDirs(ctx, opts.seededWorktreeDirs ?? []);
  if (opts.claude) assertNoClaudeCalls(opts.claude);
  ctx.log("channel session stopped at the starter — OK");
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
export function assertWorktreeDirs(ctx: ScenarioContext, expected: string[]): void {
  if (!existsSync(PROJECTS_DIR)) return;
  const found = readdirSync(PROJECTS_DIR)
    .filter((entry) => entry.startsWith("nimbus-") || entry.startsWith("lumen-"))
    .sort();
  const extras = found.filter((entry) => !expected.includes(entry));
  if (extras.length > 0) {
    throw new Error(`unexpected worktree dirs under ${PROJECTS_DIR}: ${extras.join(", ")}`);
  }
  ctx.log(
    expected.length === 0
      ? "no worktree dirs created — OK"
      : `only the seeded worktrees present (${found.join(", ")}) — OK`,
  );
}

export function assertNoWorktreeDirs(ctx: ScenarioContext): void {
  assertWorktreeDirs(ctx, []);
}

export function assertNoClaudeCalls(claude: ClaudeMockHandle): void {
  if (claude.claudeCalls.length === 0) return;
  throw new Error(
    `expected no claude call; got ${claude.claudeCalls.length}: ${JSON.stringify(
      claude.claudeCalls.map((c) => c.argv[0]?.slice(0, 60)),
    )}`,
  );
}
