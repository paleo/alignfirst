import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe } from "./_lib/common-constants.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { LUMEN_PROJECT_PATH, NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

export default async function multiProjectHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: "Rafraîchis les branches de base de nimbus et lumen.",
    codingAgent,
  });

  ctx.assertRegex(starter.match.text, /\bnimbus\b/iu, "starter carries nimbus");
  ctx.assertRegex(starter.match.text, /\blumen\b/iu, "starter carries lumen");
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(NIMBUS_PROJECT_PATH), "u"),
    "starter carries the nimbus path",
  );
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(LUMEN_PROJECT_PATH), "u"),
    "starter carries the lumen path",
  );
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread-opening handoff for refreshing the base branches of both nimbus and lumen. It " +
      "does not ask the user to choose one main project or supply a ticket. It asks only for a " +
      "reply in the thread and does not claim that either refresh has started.",
    label: "multi-project-deferred-to-working-session",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
