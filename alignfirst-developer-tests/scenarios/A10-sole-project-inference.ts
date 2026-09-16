import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import {
  LUMEN_PROJECT_PATH,
  NIMBUS_PROJECT_PATH,
  ORION_PROJECT_PATH,
} from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0100";

export default async function soleProjectInference(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  await ctx.execInGateway(["rm", "-rf", LUMEN_PROJECT_PATH, ORION_PROJECT_PATH]);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Ticket ${TICKET_ID} : passer le bouton d'export en gras.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
  });
  const ack = await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 240_000,
  });
  await runWorkspaceFlow(ctx, codingAgent, {
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    prevStep: ack,
  });
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
