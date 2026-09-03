import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe } from "./_lib/common-constants.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertGatewayCommand, waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { EXTERNAL_PROJECT_PARENT, NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0150";
const DUPLICATE_PATH = `${EXTERNAL_PROJECT_PARENT}/${PROJECT}`;

export default async function duplicateProjectName(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  await seedDuplicateProject(ctx);
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
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function seedDuplicateProject(ctx: ScenarioContext): Promise<void> {
  await assertGatewayCommand(
    ctx,
    ["git", "init", "-q", "-b", "main", DUPLICATE_PATH],
    "duplicate project git initialization",
  );
  const config = JSON.stringify({ schemaVersion: 1, ticketPattern: "^ABC-\\d+$" }, null, 2);
  await assertGatewayCommand(
    ctx,
    ["sh", "-c", `printf '%s\\n' '${config}' > '${DUPLICATE_PATH}/.alignfirst.json'`],
    "duplicate project configuration",
  );
}
