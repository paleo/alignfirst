import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusExistingWorktreeRubric } from "./_lib/common-constants.ts";
import { seedWorktree, worktreePath } from "./_lib/fixture-state.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, waitForReport } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import {
  assertWorktreeDirs,
  bootstrapThreadFromChannel,
  sendInThread,
} from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-070";
const BRANCH_DESC = "export-bold";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;
const PROJECTS_DIR = "/home/claw/projects";

/**
 * A status request on a ticket whose workspace is already registered. The
 * channel session hands off; the thread session attaches to the existing
 * worktree (Step 4 sub-path 1) and reports its state, creating nothing.
 */
export default async function statusExistingWorktree(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const seededPath = await seedWorktree(ctx, PROJECT, TICKET_ID, BRANCH_DESC);
  const seededDir = worktreePath(PROJECT, TICKET_ID, BRANCH_DESC).slice(PROJECTS_DIR.length + 1);
  ctx.log(`pre-seeded worktree at ${seededPath}`);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
    project: PROJECT,
    claude,
    seededWorktreeDirs: [seededDir],
  });
  await sendInThread(ctx, starter.threadId, "Vas-y.");

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
      failFastCliMockGraceMs: 30_000,
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
  // WORK-mode turn (workspace setup goes through alcode). The trajectory snapshot
  // flushes when the session run ends, after the report — hence the generous timeout.
  await ctx.waitForAgentToolCall((c) => execMatches(c, /alcode\s+--openclaw-guide\b/), {
    label: "agent runs `alcode --openclaw-guide`",
    timeoutMs: 120_000,
  });

  // A status report may be composed from repo/workflow metadata (git, gh, ls,
  // DEVELOPMENT.md, .plans/) OR via alcode — both are fine, so we don't assert
  // how the status was gathered, only that the report is correct (rubric above),
  // lands in the thread, and leaves no stray worktrees / channel leak.
  assertWorktreeDirs(ctx, [seededDir]);
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
