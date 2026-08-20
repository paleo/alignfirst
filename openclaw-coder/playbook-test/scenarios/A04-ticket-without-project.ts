import type { ScenarioContext } from "@paleo/openclaw-test";
import { askWhichProjectRubric } from "./_lib/common-constants.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const TICKET_ID = "ABC-040";

/**
 * A ticket with no project. The starter carries the ticket and asks which
 * project it belongs to; the channel session then stops, waiting for the
 * answer that will wake the thread session.
 */
export default async function ticketWithoutProject(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Ticket ${TICKET_ID}, on doit corriger le bug d'export.`,
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: askWhichProjectRubric(TICKET_ID),
    label: "ask-which-project",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
