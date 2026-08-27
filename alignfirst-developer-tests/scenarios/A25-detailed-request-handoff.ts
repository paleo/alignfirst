import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const REQUEST = `Sur nimbus, réorganise la page d'export.

- Le filtre de région doit rester visible pendant le défilement.
- Le bouton doit expliquer pourquoi il est désactivé.
- Préserve le comportement clavier et les lecteurs d'écran.`;

export default async function detailedRequestHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: REQUEST,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    request: REQUEST,
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread-opening handoff for the detailed French nimbus request. It preserves all three " +
      "requirements in their original language. It defers ticket creation or collection to the " +
      "working session, asks only for a reply in the thread, and claims no work has started.",
    label: "detailed-request-preserved",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
