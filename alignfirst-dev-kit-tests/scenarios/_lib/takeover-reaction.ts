import type { AgentToolCall, ScenarioContext } from "@alignfirst/openclaw-test";
import { getQaBusState } from "@alignfirst/openclaw-channel-mock-core";
import { inputOf } from "./agent-tool-calls.ts";
import type { Step } from "./types.ts";

const TAKEOVER_TIMEOUT_MS = 120_000;
const SURFACE_MUTATING_ACTIONS = new Set([
  "delete",
  "edit",
  "react",
  "send",
  "sendAttachment",
  "sendMessage",
  "thread-create",
  "thread-reply",
  "threadReply",
]);

export async function expectTakeoverReaction(ctx: ScenarioContext, starter: Step): Promise<string> {
  const claim = await waitForClaim(ctx, starter.threadId);
  const sessionKey = requireSessionKey(claim);
  requireClaimedResult(claim);
  const historyRead = await waitForMessageAction(ctx, sessionKey, "read");
  const reaction = await waitForMessageAction(ctx, sessionKey, "react");
  const calls = (await ctx.getAgentToolCalls()).filter((call) => call.sessionKey === sessionKey);
  assertTakeoverOrder(ctx, calls, claim, historyRead, reaction);
  const messageId = newestVisibleMessageId(historyRead);
  const emoji = expectedEmoji(ctx);
  assertReactionInput(ctx, historyRead, reaction, messageId, emoji);
  await assertVisibleReaction(ctx, messageId, emoji);
  return sessionKey;
}

async function waitForClaim(ctx: ScenarioContext, threadId: string): Promise<AgentToolCall> {
  return await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      call.sessionKey?.toLowerCase().includes(threadId.toLowerCase()) === true &&
      call.result !== undefined,
    { label: "thread session claims its handoff", timeoutMs: TAKEOVER_TIMEOUT_MS },
  );
}

function requireSessionKey(claim: AgentToolCall): string {
  if (claim.sessionKey !== undefined) return claim.sessionKey;
  throw new Error("Fresh takeover claim lacks session attribution");
}

function requireClaimedResult(claim: AgentToolCall): void {
  const result = parseJsonToolResult(claim, "fresh takeover claim");
  if (result.status === "claimed") return;
  throw new Error(
    `Fresh takeover claim returned ${JSON.stringify(result.status)}, expected status "claimed"`,
  );
}

async function waitForMessageAction(
  ctx: ScenarioContext,
  sessionKey: string,
  action: "read" | "react",
): Promise<AgentToolCall> {
  return await ctx.waitForAgentToolCall(
    (call) =>
      call.sessionKey === sessionKey &&
      call.toolName === "message" &&
      inputOf(call).action === action &&
      call.result !== undefined,
    { label: `takeover ${action}s the visible thread`, timeoutMs: TAKEOVER_TIMEOUT_MS },
  );
}

function assertTakeoverOrder(
  ctx: ScenarioContext,
  calls: AgentToolCall[],
  claim: AgentToolCall,
  historyRead: AgentToolCall,
  reaction: AgentToolCall,
): void {
  const claimIndex = callIndex(calls, claim.toolUseId, "claim");
  const readIndex = callIndex(calls, historyRead.toolUseId, "history read");
  const reactionIndex = callIndex(calls, reaction.toolUseId, "reaction");
  if (!(claimIndex < readIndex && readIndex < reactionIndex)) {
    throw new Error(
      `Bad takeover ordering: claim=${claimIndex}, history read=${readIndex}, reaction=${reactionIndex}`,
    );
  }
  const claims = calls.filter(
    (call) => call.toolName === "thread_handoff" && inputOf(call).action === "claim",
  );
  ctx.assertLength(claims, 1, "fresh takeover claims exactly once");
  const reactions = calls.filter(
    (call) => call.toolName === "message" && inputOf(call).action === "react",
  );
  ctx.assertLength(reactions, 1, "fresh takeover reacts exactly once");
  const earlyMutations = calls
    .slice(0, reactionIndex)
    .filter((call) => isSurfaceMutatingMessageCall(call));
  ctx.assertLength(earlyMutations, 0, "takeover reaction is the first surface mutation");
}

function callIndex(calls: AgentToolCall[], toolUseId: string, label: string): number {
  const index = calls.findIndex((call) => call.toolUseId === toolUseId);
  if (index >= 0) return index;
  throw new Error(`Bad takeover ordering: ${label} call is missing from the transcript snapshot`);
}

function isSurfaceMutatingMessageCall(call: AgentToolCall): boolean {
  const action = inputOf(call).action;
  return (
    call.toolName === "message" &&
    typeof action === "string" &&
    SURFACE_MUTATING_ACTIONS.has(action)
  );
}

function newestVisibleMessageId(historyRead: AgentToolCall): string {
  const result = parseJsonToolResult(historyRead, "thread history read");
  if (!Array.isArray(result.messages) || result.messages.length === 0) {
    throw new Error("Thread history read returned no visible messages");
  }
  const newest = result.messages.at(-1);
  if (!isRecord(newest) || typeof newest.id !== "string" || newest.id.length === 0) {
    throw new Error("Newest visible history message has no string ID");
  }
  return newest.id;
}

function expectedEmoji(ctx: ScenarioContext): string {
  if (ctx.channel === "slack-mock") return "eyes";
  if (ctx.channel === "discord-mock") return "👀";
  throw new Error(`No takeover reaction contract for channel ${ctx.channel}`);
}

function assertReactionInput(
  ctx: ScenarioContext,
  historyRead: AgentToolCall,
  reaction: AgentToolCall,
  messageId: string,
  emoji: string,
): void {
  const readInput = inputOf(historyRead);
  const reactionInput = inputOf(reaction);
  if (typeof readInput.target !== "string" || readInput.target.length === 0) {
    throw new Error("Thread history read lacks its complete target");
  }
  ctx.assertEqual(
    reactionInput.messageId,
    messageId,
    "reaction targets the newest visible history message",
  );
  ctx.assertEqual(reactionInput.target, readInput.target, "reaction keeps the history read target");
  ctx.assertEqual(reactionInput.channel, ctx.channel, "reaction uses the active channel");
  ctx.assertEqual(reactionInput.emoji, emoji, "reaction uses the surface eyes emoji");
}

async function assertVisibleReaction(
  ctx: ScenarioContext,
  messageId: string,
  emoji: string,
): Promise<void> {
  const snapshot = await getQaBusState(ctx.busUrl);
  const message = snapshot.messages.find(
    (candidate) => candidate.accountId === ctx.accountId && candidate.id === messageId,
  );
  if (!message) throw new Error(`Reacted visible message ${messageId} is missing from the bus`);
  ctx.assertLength(message.reactions, 1, "visible takeover message has exactly one reaction");
  const [reaction] = message.reactions;
  if (!reaction) throw new Error("Visible takeover reaction is missing from the bus");
  ctx.assertEqual(reaction.emoji, emoji, "visible takeover reaction uses the surface eyes emoji");
  ctx.assertEqual(reaction.senderId, "openclaw", "visible takeover reaction uses the bot sender");
}

function parseJsonToolResult(call: AgentToolCall, label: string): Record<string, unknown> {
  const body = toolResultBody(call.result?.content, label);
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${detail}`);
  }
  throw new Error(`${label} returned JSON that is not an object`);
}

function toolResultBody(content: unknown, label: string): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every(isTextBlock)) {
    return content.map((block) => block.text).join("");
  }
  throw new Error(`${label} has an unsupported tool-result body`);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
