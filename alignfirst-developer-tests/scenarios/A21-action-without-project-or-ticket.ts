import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

/**
 * A concrete task with neither a project nor a ticket is still actionable. The
 * channel session opens a thread, asks for the missing project there, and does
 * none of the work itself.
 */
export default async function actionWithoutProjectOrTicket(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: "Peux-tu rendre le bouton d'export plus visible ?",
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread-opening handoff for making an export button more visible. It asks which project " +
      "the work belongs to and does not claim that implementation, investigation, workspace " +
      "setup, or coding has started. The question may be in French.",
    label: "action-without-project-or-ticket-handoff",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
