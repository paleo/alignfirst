import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PULL_REQUEST_URL = "https://github.com/acme/nimbus/pull/42";

export default async function resourceUrlHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Peux-tu relire ${PULL_REQUEST_URL} ?`,
    project: "nimbus",
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      `A thread-opening handoff for reviewing ${PULL_REQUEST_URL}. It retains the URL and asks ` +
      "the user to reply in the thread so the working session can start. It may promise that the " +
      "working session will derive the ticket from the URL, but does not ask the user for a " +
      "ticket ID or claim that the pull request has already been read.",
    label: "resource-url-deferred-to-working-session",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
