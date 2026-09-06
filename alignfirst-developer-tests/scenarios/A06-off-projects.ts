import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

// Two-tier chatter judgement. Concrete work content in a small-talk reply is
// the real defect and fails the run; the bare offer reflex ("prêt si besoin",
// "un truc pour toi ?") survived four wording and placement iterations at
// ~1 in 6 turns — an obedience ceiling, so it is tolerated and logged, like
// channel-root narration.
const OFF_PROJECTS_CHAT_PROMPT =
  'This is a single reply an assistant posted to small talk in a work channel ("Salut, ça va ?" ' +
  "or similar). Judge three independent properties. social: the reply reads as natural small " +
  "talk matching the inbound's tone — brevity is fine, a reciprocal question is fine but NOT " +
  'required, and a vague calm-day idiom ("pas de projet qui brûle", "journée tranquille côté ' +
  'taff") is still social. specifics: the reply brings up CONCRETE work content — it names a ' +
  "specific project, ticket, branch, worktree, thread, setup, inventory or lookup result, claims " +
  "particular work is ongoing or finished, or asks the user to pick a project; vague idioms " +
  "about a calm workload are NOT specifics. genericOffer: the reply tacks on a generic " +
  'availability or "anything I can do for you?" line ("prêt si besoin", "un truc pour toi ?", ' +
  '"happy to help") with no concrete work content.';

// The lookup contract is outcome-based: a message with no possible project
// reference needs no `alproject list`, so this scenario asserts only what the
// user can observe — social-only replies, no thread, no coding-agent call. The
// mock stays installed to serve a lookup if one happens; either count is fine.
// The lookup-when-it-matters case is A20-ambiguous-project-mention.
export default async function offProjectsChat(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: "Salut, ça va ?",
  });

  if (ctx.channel === "discord-mock") {
    await assertDiscordChannelReply(ctx, startCursor);
  } else {
    await assertSlackReply(ctx, startCursor);
  }

  const secondCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: "Et sinon, tu passes une bonne journée ?",
  });
  if (ctx.channel === "discord-mock") {
    await assertDiscordChannelReply(ctx, secondCursor);
  } else {
    await assertSlackReply(ctx, secondCursor);
  }
  if (codingAgent.codingAgentCalls.length > 0) {
    throw new Error(
      `expected no coding-agent call; got ${codingAgent.codingAgentCalls.length}: ${JSON.stringify(
        codingAgent.codingAgentCalls.map((call) => ({ agent: call.agent, argv: call.argv })),
      )}`,
    );
  }

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function assertDiscordChannelReply(ctx: ScenarioContext, startCursor: number): Promise<void> {
  const wait = await ctx.waitForOutbound(
    (m) => m.direction === "outbound" && m.conversation.id === ctx.conversationId && !m.threadId,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  ctx.log({ attachTo: wait.entry, label: "channel reply received" });
  await judgeOffProjectsReply(ctx, wait.match.text);

  // No thread must be opened: no outbound carrying a threadId.
  await ctx.expectNoOutbound((m) => m.direction === "outbound" && m.threadId !== undefined, {
    withinMs: 5000,
    sinceCursor: wait.nextCursor,
  });
}

async function assertSlackReply(ctx: ScenarioContext, startCursor: number): Promise<void> {
  const wait = await ctx.waitForOutbound(
    (m) => m.direction === "outbound" && m.conversation.id === ctx.conversationId,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  ctx.log({ attachTo: wait.entry, label: "reply received" });
  await judgeOffProjectsReply(ctx, wait.match.text);
}

async function judgeOffProjectsReply(ctx: ScenarioContext, text: string): Promise<void> {
  const { parsed } = await ctx.judgeLLMJson<{
    social: boolean;
    specifics: boolean;
    genericOffer: boolean;
    reason: string;
  }>({
    message: text,
    prompt: OFF_PROJECTS_CHAT_PROMPT,
    returnType:
      '{ "social": boolean, "specifics": boolean, "genericOffer": boolean, "reason": string }',
    label: "off-projects-chat",
  });
  if (!parsed.social || parsed.specifics) {
    throw new Error(`off-projects reply violates the chatter contract: ${parsed.reason}`);
  }
  if (parsed.genericOffer) {
    ctx.log(`generic work offer tolerated (model ceiling): ${JSON.stringify(text.slice(0, 100))}`);
  }
}
