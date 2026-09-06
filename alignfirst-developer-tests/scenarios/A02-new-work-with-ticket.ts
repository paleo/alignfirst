import type { ScenarioContext } from "@paleo/openclaw-test";
import { HANDOFF_ASK_RUBRIC } from "./_lib/common-constants.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";
import type { Step } from "./_lib/types.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-020";
const PROJECT = "nimbus";

/**
 * Project and ticket both supplied in the channel message — nothing is missing,
 * and the channel session still only opens the thread. With no value left to
 * ask for, the starter asks the user for a message so the thread session can
 * take over. That message is content-free ("Vas-y."): the task comes from the
 * starter, and the thread session runs setup and delegation off it.
 */
export default async function projectDetectionWithTicket(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: HANDOFF_ASK_RUBRIC,
    label: "starter-handoff-ask",
  });

  const ack = await handOffAndExpectSetupAck(ctx, starter);
  await runWorkspaceFlow(ctx, codingAgent, {
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    prevStep: ack,
  });
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.log({ attachTo: ack.entry, label: "setup ack received" });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function handOffAndExpectSetupAck(ctx: ScenarioContext, starter: Step): Promise<Step> {
  await sendInThread(ctx, starter.threadId, "Vas-y.");

  return await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 180_000,
  });
}
