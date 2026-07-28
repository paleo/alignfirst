import type { ScenarioContext } from "@paleo/openclaw-test";
import { unknownProjectRubric } from "./_lib/common-constants.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const WRONG_PROJECT = "aurora";

/**
 * A project name absent from `~/projects/`. The channel session checks the name
 * while collecting the handoff values, so the starter says the project isn't
 * there and asks for the right one — then stops.
 */
export default async function wrongProject(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Sur ${WRONG_PROJECT}, le bouton d'export ne marche plus.`,
    claude,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: unknownProjectRubric(WRONG_PROJECT),
    label: "unknown-project-acknowledgement",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
