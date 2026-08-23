import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { assertBranch, seedBranch, waitForWorktreeDir } from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, waitForReport } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-080";
const BRANCH_DESC = "retry-logic";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;

/**
 * A status request on a ticket that has a branch but no workspace. The channel
 * session hands off; the thread session sets a workspace up on the existing
 * branch (Step 4 sub-path 2) — never a new branch — and reports its state.
 */
export default async function statusBranchOnly(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  await seedBranch(ctx, NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC);
  ctx.log(`pre-seeded branch ${BRANCH} (no worktree)`);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    codingAgent,
  });
  await sendInThread(ctx, starter.threadId, "Vas-y.");

  const worktreeDir = await waitForWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, BRANCH_DESC, {
    timeoutMs: 120_000,
  });
  assertBranch(worktreeDir, BRANCH);
  ctx.log(`worktree appeared at ${worktreeDir} on existing branch`);

  // The status report uses the `[WORKSPACE]` banner from
  // project-workspace-setup.md Step 4 (`Worktree : … / Branche : … /
  // Status : …`). Match on the worktree dir — narration messages with the
  // branch token but no template keyword are skipped.
  const reportRe = new RegExp(`nimbus-${TICKET_ID}-${BRANCH_DESC}`);
  const reportWait = await waitForReport(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.id !== starter.match.id &&
      reportRe.test(m.text),
    {
      sinceCursor: starter.nextCursor,
      // The takeover-sync between the `gh pr list` call and the report (deps
      // check, base-branch check, report drafting) can exceed 30s on a slow
      // model — give the CLI-mock grace real headroom.
      failFastCliMockGraceMs: 90_000,
    },
  );
  ctx.log({ attachTo: reportWait.entry, label: "status report received" });
  ctx.assertEqual(
    reportWait.match.threadId,
    starter.threadId,
    "status report posted in the thread",
  );
  ctx.assertRegex(
    reportWait.match.text,
    new RegExp(`nimbus-${TICKET_ID}-${BRANCH_DESC}`),
    "report mentions the worktree path",
  );
  ctx.assertRegex(
    reportWait.match.text,
    new RegExp(`\\b${TICKET_ID}/${BRANCH_DESC}\\b`),
    "report mentions the branch",
  );
  ctx.assertRegex(
    reportWait.match.text,
    /\b(running|ready|failed|pending|ok|prêt|en cours|terminé)\b/i,
    "report mentions a workspace status",
  );
  ctx.assertRegex(
    reportWait.match.text,
    /\[WORKSPACE\]/,
    "report carries the [WORKSPACE] banner tag",
  );

  // project-workspace-setup.md prerequisite: run the delegation manual on every
  // setup turn. The trajectory snapshot flushes when the session run ends,
  // after the report — hence the generous timeout.
  await ctx.waitForAgentToolCall((c) => execMatches(c, /alcode\s+--openclaw-guide\b/), {
    label: "agent runs `alcode --openclaw-guide`",
    timeoutMs: 120_000,
  });

  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
