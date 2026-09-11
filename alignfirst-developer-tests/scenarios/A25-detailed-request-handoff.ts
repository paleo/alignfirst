import type { ScenarioContext } from "@paleo/openclaw-test";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { expectCodingDelegation, setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { waitForReport } from "./_lib/outbound.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { waitForCapturedRequest } from "./_lib/request-file.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const TICKET_ID = "ABC-0250";
const REQUEST = `Sur nimbus, réorganise la page d'export.

- Le filtre de région doit rester visible pendant le défilement.
- Le bouton doit expliquer pourquoi il est désactivé.
- Préserve le comportement clavier et les lecteurs d'écran.`;

export default async function detailedRequestHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: REQUEST,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    request: REQUEST,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread-opening handoff for the detailed French nimbus request. It preserves all three " +
      "requirements in their original language without inventing additional task requirements. It may ask for the missing ticket itself or " +
      "leave that question to the thread session, without asking for a content-free activation message.",
    label: "detailed-request-preserved",
  });
  await waitForProjectListing(ctx, "channel session lists the projects");

  const { parsed } = await ctx.judgeLLMJson<{ asks: boolean }>({
    message: starter.match.text,
    prompt: "Does this thread starter ask the user for the missing ticket ID?",
    returnType: '{ "asks": boolean }',
    label: "starter-ticket-question",
  });
  if (!parsed.asks) {
    const ticketQuestion = await waitForReport(
      ctx,
      (message) =>
        message.direction === "outbound" &&
        message.threadId === starter.threadId &&
        /(?:ticket|identifiant)/iu.test(message.text),
      { sinceCursor: starter.nextCursor, timeoutMs: 120_000 },
    );
    await ctx.judgeLLM({
      attachTo: ticketQuestion.entry,
      message: ticketQuestion.match.text,
      rubric:
        "A question asking for the ticket ID needed to continue the detailed nimbus request. " +
        "Plain prose or a structured choice both count. Reject a claim that a workspace exists " +
        "or that coding has started.",
      label: "detailed-request-ticket-question",
    });
  }

  await sendInThread(ctx, starter.threadId, `Utilise le ticket ${TICKET_ID}.`);
  const requestPath = `${NIMBUS_PROJECT_PATH}/.plans/${TICKET_ID}/A1-request.md`;
  await waitForCapturedRequest(requestPath, REQUEST, 120_000);

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 180_000,
  });
  assertBranchForTicket(worktreeDir, TICKET_ID);
  const delegation = await expectCodingDelegation(ctx, codingAgent, {
    ticketId: TICKET_ID,
    rubric:
      `An AlignFirst coding-protocol delegation for ticket ${TICKET_ID} covering the detailed ` +
      "export-page request. The three requirements — sticky region filter, an explanation for " +
      "the disabled export button, preserved keyboard and screen-reader behavior — may be " +
      "spelled out in the prompt, or carried by a reference to the captured request file " +
      `(.plans/${TICKET_ID}/A1-request.md holds the full request; pointing the agent at it ` +
      "counts as covering all three). Reject only if the prompt neither references the request " +
      "file nor covers the requirements.",
    label: "detailed-request-coding-delegation",
    timeoutMs: 240_000,
  });
  if (delegation.cwd !== worktreeDir) {
    throw new Error(`coding ran from ${delegation.cwd}, expected linked worktree ${worktreeDir}`);
  }

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
