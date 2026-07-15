import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { assertBranch, seedBranch, waitForWorktreeDir } from "./_lib/fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, requireThreadId, waitForStarter } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-080";
const BRANCH_DESC = "retry-logic";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;

export default async function statusBranchOnly(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  setupClaudeMock(ctx);
  setupGhMock(ctx);

  await seedBranch(ctx, PROJECT, TICKET_ID, BRANCH_DESC);
  ctx.log(`pre-seeded branch ${BRANCH} (no worktree)`);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
  });

  const starterWait = await waitForStarter(ctx, { sinceCursor: startCursor });
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  const worktreeDir = await waitForWorktreeDir(PROJECT, TICKET_ID, BRANCH_DESC, {
    timeoutMs: 120_000,
  });
  assertBranch(worktreeDir, BRANCH);
  ctx.log(`worktree appeared at ${worktreeDir} on existing branch`);

  // The status report uses the templated `Worktree : … / Branche : … /
  // Bootstrap : …` shape from project-workspace-setup.md Step 4. Match
  // on that — narration messages with the branch token but no template keyword
  // are skipped.
  const reportRe = new RegExp(`nimbus-${TICKET_ID}-${BRANCH_DESC}`);
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.id !== starterWait.match.id &&
      reportRe.test(m.text),
    {
      timeoutMs: 180_000,
      sinceCursor: starterWait.nextCursor,
      // The takeover-sync between the `gh pr list` call and the report (deps
      // check, base-branch check, report drafting) can exceed 30s on a slow
      // model — keep the fail-fast, but give it real headroom.
      failFastCliMockGraceMs: 90_000,
      failFastUnmatchedOutbounds: false,
    },
  );
  ctx.log({ attachTo: reportWait.entry, label: "status report received" });
  // Free-form text after `thread-create` auto-streams to the parent channel —
  // the report must land in the thread, and a leak fails here with the real cause.
  ctx.assertEqual(reportWait.match.threadId, threadId, "status report posted in the thread");
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
    "report mentions a bootstrap status",
  );

  // project-workspace-setup.md prerequisite: run the delegation manual on every
  // WORK-mode turn. The trajectory snapshot flushes when the session run ends,
  // after the report — hence the generous timeout.
  await ctx.waitForAgentToolCall((c) => execMatches(c, /alcode\s+--openclaw-guide\b/), {
    label: "agent runs `alcode --openclaw-guide`",
    timeoutMs: 120_000,
  });

  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
