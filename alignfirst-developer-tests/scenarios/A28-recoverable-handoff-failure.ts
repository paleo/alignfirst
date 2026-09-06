import { failNextQaBusOperation } from "@paleo/openclaw-channel-mock-core";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { inputOf } from "./_lib/agent-tool-calls.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0280";

/** The first native delivery fails once; retry must reuse the original target and starter. */
export default async function recoverableHandoffFailure(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);
  await failNextQaBusOperation({
    baseUrl: "http://bus:43123",
    operation: ctx.channel === "slack-mock" ? "outbound-message" : "thread-create",
    message: "planned recoverable starter failure",
  });

  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité sur ${PROJECT}: passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}. Si la livraison du starter échoue une fois, réessaie sur la même cible.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });
  const calls = await ctx.getAgentToolCalls();
  const failedNativeCalls = calls.filter((call) => {
    const input = inputOf(call);
    return (
      call.toolName === "message" &&
      (input.action === "send" || input.action === "thread-create") &&
      JSON.stringify(call.result).includes("planned recoverable starter failure")
    );
  });
  ctx.assertLength(failedNativeCalls, 1, "one recoverable native starter failure observed");

  const ack = await waitForSetupAck(ctx, {
    threadId: starter.threadId,
    prevId: starter.match.id,
    sinceCursor: starter.nextCursor,
    timeoutMs: 180_000,
  });
  await runWorkspaceFlow(ctx, codingAgent, {
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    prevStep: ack,
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
