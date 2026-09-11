import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { ORION_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-020";
const PROJECT = "orion";

/**
 * Project and ticket both supplied in the channel message — nothing is missing,
 * and the thread starts automatically. The project lives outside the primary
 * project directory, so setup and delegation must retain its canonical path.
 */
export default async function projectDetectionWithTicket(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}.`,
    project: PROJECT,
    projectPath: ORION_PROJECT_PATH,
    ticketId: TICKET_ID,
  });

  const ack = await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 240_000,
  });
  const worktreePath = await runWorkspaceFlow(ctx, codingAgent, {
    projectPath: ORION_PROJECT_PATH,
    ticketId: TICKET_ID,
    prevStep: ack,
  });
  const delegation = codingAgent.codingAgentCalls.find(
    (call) => call.cwd === worktreePath && isCodingProtocolPrompt(extractCodingPrompt(call)),
  );
  if (delegation === undefined) {
    throw new Error(`coding delegation did not run from external worktree ${worktreePath}`);
  }
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.log({ attachTo: ack.entry, label: "setup ack received" });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
