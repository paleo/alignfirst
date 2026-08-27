import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe } from "./_lib/common-constants.ts";
import { setupAlprojectMock, registeredProject } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import {
  EXTERNAL_PROJECT_PARENT,
  NIMBUS_PROJECT_PATH,
  PRIMARY_PROJECT_PARENT,
} from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0150";
const DUPLICATE_PATH = `${EXTERNAL_PROJECT_PARENT}/${PROJECT}`;

export default async function duplicateProjectName(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx, {
    projects: [
      registeredProject(PROJECT, NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT),
      registeredProject(PROJECT, DUPLICATE_PATH, EXTERNAL_PROJECT_PARENT),
    ],
  });
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Sur ${PROJECT}, ticket ${TICKET_ID}, passe le bouton d'export en gras.`,
    project: PROJECT,
    ticketId: TICKET_ID,
    codingAgent,
  });
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(NIMBUS_PROJECT_PATH)),
    "duplicate-name ask lists the primary canonical path",
  );
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(DUPLICATE_PATH)),
    "duplicate-name ask lists the external canonical path",
  );
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      `The message asks the user to choose which canonical path identifies project ${PROJECT}. ` +
      `It lists both ${NIMBUS_PROJECT_PATH} and ${DUPLICATE_PATH}. It does not claim that setup ` +
      "or coding has started.",
    label: "duplicate-project-path-choice",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
