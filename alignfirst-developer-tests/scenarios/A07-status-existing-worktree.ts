import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusExistingWorktreeRubric } from "./_lib/common-constants.ts";
import { seedWorktree, worktreePath } from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, waitForReport } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { assertWorktreePaths, bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-070";
const BRANCH_DESC = "export-bold";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;

/**
 * A status request on a ticket whose workspace is already registered. The
 * channel session hands off; the thread session attaches to the existing
 * worktree (Step 4 sub-path 1) and reports its state, creating nothing.
 */
export default async function statusExistingWorktree(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const seededPath = await seedWorktree(ctx, NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC);
  const seededWorktreePath = worktreePath(NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC);
  ctx.log(`pre-seeded worktree at ${seededPath}`);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    codingAgent,
    seededWorktreePaths: [seededWorktreePath],
  });
  // Matched at conversation level on purpose: a report that leaked to the
  // channel root fails on the placement assert below, with the real cause,
  // instead of surfacing as a wait timeout.
  const branchRe = new RegExp(
    `\\b${TICKET_ID}/${BRANCH_DESC}\\b|nimbus-${TICKET_ID}-${BRANCH_DESC}\\b`,
  );
  const reportWait = await waitForReport(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.id !== starter.match.id &&
      branchRe.test(m.text),
    {
      sinceCursor: starter.nextCursor,
    },
  );
  ctx.log({ attachTo: reportWait.entry, label: "status report received" });
  ctx.assertEqual(
    reportWait.match.threadId,
    starter.threadId,
    "status report posted in the thread",
  );
  await ctx.judgeLLM({
    attachTo: reportWait.entry,
    message: reportWait.match.text,
    rubric: statusExistingWorktreeRubric(TICKET_ID, BRANCH),
    label: "status-existing-worktree",
  });

  // project-workspace-setup.md prerequisite: run the delegation manual on every
  // setup turn (workspace setup goes through alcode). The call can come late in
  // a long turn — hence the generous timeout.
  await ctx.waitForAgentToolCall((c) => execMatches(c, /alcode\s+--openclaw-guide\b/), {
    label: "agent runs `alcode --openclaw-guide`",
    timeoutMs: 120_000,
  });

  // A status report may be composed from repo/workflow metadata (git, gh, ls,
  // DEVELOPERS.md, .plans/) OR via alcode — both are fine, so we don't assert
  // how the status was gathered, only that the report is correct (rubric above),
  // lands in the thread, and leaves no stray worktrees / channel leak.
  assertWorktreePaths(ctx, [seededWorktreePath]);
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
