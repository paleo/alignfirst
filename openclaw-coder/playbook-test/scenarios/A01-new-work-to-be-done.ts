import type { ScenarioContext } from "@paleo/openclaw-test";
import { NEW_WORK_QUESTION_RUBRIC } from "./_lib/common-constants.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";
import type { Step } from "./_lib/types.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-010";
const PROJECT = "nimbus";

/**
 * Work intent with no ticket. The channel session opens a thread whose starter
 * names the project and asks for the missing details, then stops. The user's
 * answer lands in the thread, waking the session that owns the work: it posts
 * the setup signal, sets up the workspace (the `[WORKSPACE]` banner), and
 * delegates — with no second go-ahead, since the answer itself is the request.
 */
export default async function projectDetectionStarter(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: "Nous avons un travail à faire sur nimbus.",
    project: PROJECT,
    audience: "tech",
    codingAgent,
  });

  // The starter is the channel session's only post, so the ask for the ticket
  // and the scope has to be in it.
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: NEW_WORK_QUESTION_RUBRIC,
    label: "starter-work-question",
  });

  const ack = await sendTicketAndExpectSetupSignal(ctx, starter);
  await runWorkspaceFlow(ctx, codingAgent, {
    project: PROJECT,
    ticketId: TICKET_ID,
    prevStep: ack,
  });
  await expectThreadRenamedWithTicket(ctx);

  ctx.log({ attachTo: ack.entry, label: "setup signal received" });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function sendTicketAndExpectSetupSignal(ctx: ScenarioContext, starter: Step): Promise<Step> {
  await sendInThread(
    ctx,
    starter.threadId,
    `Ticket ${TICKET_ID}. La fonctionnalité dont nous avons besoin : passer le bouton d'export en gras.`,
  );

  return await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 180_000,
  });
}

/**
 * The channel opened the thread before the ticket existed, so its name carries
 * no ticket. Once the ticket lands in the thread, the session must rename —
 * which on Discord means a `message` call carrying `threadName` (there is no
 * rename action). Slack threads have no name, so this is Discord-only.
 */
async function expectThreadRenamedWithTicket(ctx: ScenarioContext): Promise<void> {
  if (ctx.channel !== "discord-mock") return;
  const renameRe = new RegExp(`\\b${TICKET_ID}\\b`);
  await ctx.waitForAgentToolCall(
    (call) => {
      if (call.toolName !== "message") return false;
      const name = (call.input as { threadName?: unknown } | undefined)?.threadName;
      return typeof name === "string" && renameRe.test(name);
    },
    { label: "agent renames the thread with the ticket", timeoutMs: 120_000 },
  );
}
