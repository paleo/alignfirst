import type { ScenarioContext } from "@paleo/openclaw-test";
import { HANDOFF_ASK_RUBRIC } from "./_lib/common-constants.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { ORION_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PROJECT = "orion";

/**
 * A casual message naming a listed project with no work framing. The
 * off-projects contract exempts only messages with no possible project
 * reference, and "orion" is exactly the word the bot cannot classify from
 * memory: it must consult `alproject list --json`, recognize the project, and open a
 * thread whose starter carries the canonical path. Misclassifying the message
 * as small talk is the failure this scenario exists to catch.
 */
export default async function ambiguousProjectMention(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: "Et sinon, ça avance bien sur orion ?",
    project: PROJECT,
    projectPath: ORION_PROJECT_PATH,
    codingAgent,
  });
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: HANDOFF_ASK_RUBRIC,
    label: "ambiguous-mention-handoff-ask",
  });
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
