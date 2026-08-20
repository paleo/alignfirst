import type { ScenarioContext } from "@paleo/openclaw-test";
import { OFF_PROJECTS_CHAT_RUBRIC } from "./_lib/common-constants.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

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
  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: OFF_PROJECTS_CHAT_RUBRIC,
    label: "off-projects-chat",
  });

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
  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: OFF_PROJECTS_CHAT_RUBRIC,
    label: "off-projects-chat",
  });
}
