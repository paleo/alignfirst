import type { ScenarioContext } from "@paleo/openclaw-test";
import { HANDOFF_ASK_RUBRIC } from "./_lib/common-constants.ts";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { ORION_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const PROJECT = "orion";
const TICKET_ID = "ABC-0160";

export default async function externalProjectPath(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}.`,
    project: PROJECT,
    projectPath: ORION_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric: HANDOFF_ASK_RUBRIC,
    label: "external-project-handoff-ask",
  });

  await sendInThread(ctx, starter.threadId, "Vas-y.");
  const ack = await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 180_000,
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
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
