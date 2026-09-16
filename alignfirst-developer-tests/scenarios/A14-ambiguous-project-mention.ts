import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoLiteralNoReply, waitForReport } from "./_lib/outbound.ts";
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
 * memory: it must consult `alproject list --json`, recognize the project, and open a
 * thread whose starter carries the canonical path. Misclassifying the message
 * as small talk is the failure this scenario exists to catch.
 *
 * The status question names no ticket, and a status is ticket work. The channel
 * session may ask for the ticket in the starter, or state the continuation and
 * leave the question to the thread session's seed turn; both paths end with the
 * user being asked. The ask is judged wherever it lands.
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
  await expectTicketAsk(ctx, starter);
  await assertNoLiteralNoReply(ctx, startCursor);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function expectTicketAsk(ctx: ScenarioContext, starter: Step): Promise<void> {
  const { parsed } = await ctx.judgeLLMJson<{ asks: boolean; reason: string }>({
    message: starter.match.text,
    prompt:
      "Does this thread-opening message ask the user a question about missing information (which " +
      "ticket, which scope, which project)? A statement that the follow-up continues in this " +
      "thread, with no question, is `asks: false`.",
    returnType: '{ "asks": boolean, "reason": string }',
    label: "starter-asks",
  });
  if (parsed.asks) {
    ctx.log({ attachTo: starter.entry, label: "ticket asked in the starter" });
    return;
  }
  const ask = await waitForReport(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === starter.threadId &&
      m.id !== starter.match.id &&
      /ticket/iu.test(m.text),
    { sinceCursor: starter.nextCursor, timeoutMs: 120_000 },
  );
  await ctx.judgeLLM({
    attachTo: ask.entry,
    message: ask.match.text,
    rubric:
      "A question asking the user for a ticket for the orion status, in any framing: which " +
      "ticket, a ticket id, or an offer to reserve a side ticket instead. Explaining why a ticket " +
      "is needed is fine. Fail only if it asks nothing, or claims that a workspace exists or that " +
      "inspection has started. May be in French.",
    label: "ticket-asked-in-thread",
  });
}
