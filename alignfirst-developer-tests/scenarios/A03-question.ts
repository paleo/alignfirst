import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForCodingSessionSucceeded, waitForFindingsReport } from "./_lib/coding-session.ts";
import {
  expectNoProtocolDelegation,
  extractCodingPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import {
  assertBranchForTicket,
  escapeRegExp,
  waitForAnyWorktreeDir,
} from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-030";
const QUESTION_TEXT = `Pour ${TICKET_ID} sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?`;

const INVESTIGATION_FINDING =
  "Investigation finding: handleExport in export-handler.mjs early-returns with a 204 when the region has no comparables, so the response carries no payload at all. The browser treats the empty body as a failed download and the button surfaces it as an error. Fix would be to either render a header-only CSV or surface a 'no comparables' message to the user.";

/**
 * An investigation question hands off like any other work: the channel session
 * opens the thread and stops. The thread session recovers the question from the
 * starter's task line — the channel message is invisible to it — then, since
 * single-project work always gets its workspace (read-only included), sets up
 * the ticket's workspace and delegates a no-protocol investigation to alcode
 * from the linked worktree.
 */
export default async function projectInvestigationQuestion(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  // streamDelayMs keeps the mock coding run alive past the launching turn (real runs take
  // minutes+): an exec that exits mid-turn gets its exit event consumed by the in-flight turn and
  // the completion wake never fires as its own turn — a fixture artifact, not a product behavior.
  const codingAgent = setupCodingAgentMock(ctx, {
    defaultResult: INVESTIGATION_FINDING,
    streamDelayMs: 12_000,
  });
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: QUESTION_TEXT,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    codingAgent,
  });
  await sendInThread(ctx, starter.threadId, "Vas-y.");

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 180_000,
  });
  assertBranchForTicket(worktreeDir, TICKET_ID);

  const { call: delegationCall, cursorAfterDelegation } = await expectNoProtocolDelegation(
    ctx,
    codingAgent,
    {
      rubric: `The captured invocation is a prompt sent to a coding agent via the alcode CLI, **without** an alignfirst protocol header. Expected: ticket ${TICKET_ID}; an investigation/question delegation that conveys the user's question (export button failure when there are no comparables — paraphrases are fine); and "do not implement / talk first" (or equivalent). Do not judge the project or working directory — that is asserted structurally. Reject if the prompt looks like an alignfirst protocol invocation (\`Run the _spec_ protocol …\` etc.), the ticket is missing, or the question content is missing or unrelated.`,
      label: "coding-agent-investigation-delegation",
    },
  );
  // The delegation must run from the ticket's linked worktree so the coding
  // agent investigates the right repo — checked structurally, not by the judge.
  ctx.assertRegex(
    delegationCall.cwd,
    new RegExp(`^${escapeRegExp(worktreeDir)}/?$`),
    "delegation runs from the ticket's linked worktree",
  );
  ctx.log(
    `no-protocol delegation captured (prompt length=${extractCodingPrompt(delegationCall)?.length ?? 0})`,
  );

  // The guide makes every alcode run a background task, so the findings arrive only after the
  // exec-exit wake: launch ack first, then the no-protocol session file reaches
  // `status: succeeded`, then the woken agent relays the finding in the thread.
  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: TICKET_ID,
    allowNoTicketDir: true,
    timeoutMs: 120_000,
  });
  ctx.log(`coding-session file succeeded: ${sessionFilePath}`);

  // The findings arrive only after the exec-exit wake; a batch judge picks the relayed finding out
  // of the thread window, ignoring the earlier launch ack (see `waitForFindingsReport`).
  await waitForFindingsReport(ctx, {
    conversationId: ctx.conversationId,
    threadId: starter.threadId,
    sinceCursor: cursorAfterDelegation,
    timeoutMs: 240_000,
    label: "investigation-summary",
  });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
