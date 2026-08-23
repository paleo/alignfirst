import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { ScenarioContext } from "@paleo/openclaw-test";
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
  /** Asserted as a literal `tech` / `non-tech` token in the starter. */
  audience?: "tech" | "non-tech";
  codingAgent?: CodingAgentMockHandle;
  /** Worktree paths seeded before the run; anything else on disk is the channel session's. */
  seededWorktreePaths?: string[];
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
    codingAgent: opts.codingAgent,
    seededWorktreePaths: opts.seededWorktreePaths,
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
  const projectPathLine = starterFieldLine(text, 1);
  ctx.assertRegex(projectPathLine, /^[^:\n]+:\s*\S.*$/u, "starter carries a project-path field");
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
    ctx.assertRegex(
      projectPathLine,
      new RegExp(escapeRe(opts.projectPath), "i"),
      "starter project-path field carries the canonical path",
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

function starterFieldLine(text: string, index: number): string {
  const line = text.split(/\r?\n/u).filter((candidate) => candidate.trim().length > 0)[index];
  if (line === undefined) throw new Error(`starter is missing field line ${index + 1}`);
  return line;
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
  codingAgent?: CodingAgentMockHandle;
  seededWorktreePaths?: string[];
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
  assertWorktreePaths(ctx, opts.seededWorktreePaths ?? []);
  if (opts.codingAgent) assertNoCodingAgentCalls(opts.codingAgent);
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
