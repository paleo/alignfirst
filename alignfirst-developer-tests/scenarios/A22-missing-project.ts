import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { PRIMARY_PROJECT_PARENT } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PROJECT = "ghost";
const MISSING_PROJECT_PATH = `${PRIMARY_PROJECT_PARENT}/${PROJECT}`;

export default async function missingProject(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx, {
    projects: [
      {
        name: PROJECT,
        mainPath: MISSING_PROJECT_PATH,
        parent: PRIMARY_PROJECT_PARENT,
        status: "missing",
      },
    ],
  });
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Sur ${PROJECT}, analyse pourquoi les tests sont lents.`,
    project: PROJECT,
    codingAgent,
  });
  const projectPathLine = starter.match.text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)[1];
  if (projectPathLine?.includes(MISSING_PROJECT_PATH)) {
    throw new Error(`missing project was routed as usable: ${JSON.stringify(projectPathLine)}`);
  }
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      `A thread-opening handoff for investigating slow tests in ${PROJECT}. It explains that ` +
      "the registered project is missing from the filesystem or otherwise lacks a usable path, " +
      "and asks the user for a usable registered project path. It does not claim that inspection " +
      "or work has started.",
    label: "missing-project-discrepancy",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
