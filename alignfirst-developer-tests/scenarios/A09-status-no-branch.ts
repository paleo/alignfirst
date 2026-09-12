import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusBranchOnlyRubric, statusNoBranchRubric } from "./_lib/common-constants.ts";
import { assertBranch, seedBranch, waitForWorktreeDir } from "./_lib/fixture-state.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, waitForReport } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import {
  assertNoWorktreeDirs,
  assertWorktreePaths,
  bootstrapThreadFromChannel,
  sendInThread,
} from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-090";
const BRANCH_DESC = "export-bold";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;

/** One status thread follows a ticket from absent work, to an existing branch, to a workspace. */
export default async function ticketStatusLifecycle(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  setupCodingAgentMock(ctx, {
    defaultResult:
      `Status for ${TICKET_ID}: the existing branch ${BRANCH} is clean and identical to main. ` +
      "Its linked workspace is ready. No implementation commits, pull request, or task artifacts exist.",
  });
  setupGhMock(ctx);
  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
  });
  await expectAbsentWork(ctx, starter.threadId, starter.nextCursor);
  assertNoWorktreeDirs(ctx);

  await seedBranch(ctx, NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC);
  const branchCursor = await sendInThread(
    ctx,
    starter.threadId,
    `J'ai avancé sur ${TICKET_ID} depuis. Vérifie à nouveau son état actuel.`,
  );
  const worktreeDir = await waitForWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC, {
    timeoutMs: 180_000,
  });
  assertBranch(worktreeDir, BRANCH);
  await expectWorkspaceStatus(ctx, starter.threadId, branchCursor);
  assertWorktreePaths(ctx, [worktreeDir]);

  await ctx.waitForAgentToolCall((call) => execMatches(call, /alcode\s+--openclaw-guide\b/), {
    label: "thread reads the alcode delegation guide",
    timeoutMs: 120_000,
  });
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });
  await waitForProjectListing(ctx, "channel session lists the projects");
  ctx.markScenarioAsEnded("PASS");
}

async function expectAbsentWork(
  ctx: ScenarioContext,
  threadId: string,
  sinceCursor: number,
): Promise<void> {
  const report = await waitForReport(
    ctx,
    (message) =>
      message.direction === "outbound" &&
      message.threadId === threadId &&
      message.text.includes(TICKET_ID),
    { sinceCursor },
  );
  await ctx.judgeLLM({
    attachTo: report.entry,
    message: report.match.text,
    rubric: statusNoBranchRubric(TICKET_ID),
    label: "status-no-branch",
  });
}

async function expectWorkspaceStatus(
  ctx: ScenarioContext,
  threadId: string,
  sinceCursor: number,
): Promise<void> {
  const report = await waitForReport(
    ctx,
    (message) =>
      message.direction === "outbound" &&
      message.conversation.id === ctx.conversationId &&
      message.text.includes(TICKET_ID),
    { sinceCursor },
  );
  ctx.assertEqual(report.match.threadId, threadId, "status report stays in the thread");
  await ctx.judgeLLM({
    attachTo: report.entry,
    message: report.match.text,
    rubric: statusBranchOnlyRubric(TICKET_ID, BRANCH),
    label: "status-existing-branch",
  });
}
