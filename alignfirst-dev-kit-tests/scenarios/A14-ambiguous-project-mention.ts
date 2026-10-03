import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoLiteralNoReply } from "./_lib/outbound.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { ORION_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";
import type { Step } from "./_lib/types.ts";

const PROJECT = "orion";

/**
 * A casual message naming a listed project with no work framing. The
 * off-projects contract exempts only messages with no possible project
 * reference, and "orion" is exactly the word the bot cannot classify from
 * memory: it must consult `aligndev project list --json`, recognize the project, and open a
 * thread whose starter carries the canonical path. Misclassifying the message
 * as small talk is the failure this scenario exists to catch.
 *
 * The question mentions no ticket, so the starter asks for none. The scenario
 * ends at the handoff: what the thread session answers is out of its scope.
 */
export default async function ambiguousProjectMention(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: "Et sinon, ça avance bien sur orion ?",
    project: PROJECT,
    projectPath: ORION_PROJECT_PATH,
  });
  await waitForProjectListing(ctx, "channel session lists the projects");
  await assertNoTicketAsk(ctx, starter);
  await assertNoLiteralNoReply(ctx, startCursor);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function assertNoTicketAsk(ctx: ScenarioContext, starter: Step): Promise<void> {
  const { parsed } = await ctx.judgeLLMJson<{ asksForTicket: boolean; reason: string }>({
    message: starter.match.text,
    prompt:
      "Does this thread-opening message ask the user for a ticket (a ticket id, which ticket, " +
      "or whether to create one)? May be in French.",
    returnType: '{ "asksForTicket": boolean, "reason": string }',
    label: "starter-asks-no-ticket",
  });
  if (parsed.asksForTicket) {
    throw new Error(`starter asks for a ticket: ${parsed.reason}`);
  }
  ctx.log({ attachTo: starter.entry, label: "starter asks for no ticket" });
}
