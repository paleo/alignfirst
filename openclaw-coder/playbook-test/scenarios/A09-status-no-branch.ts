import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusNoBranchRubric } from "./_lib/common-constants.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, waitForReport } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import {
  assertNoWorktreeDirs,
  bootstrapThreadFromChannel,
  sendInThread,
} from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-090";

/**
 * A status request on a ticket nobody started. The channel session hands off
 * like any other request; the thread session enters WORK mode, finds no branch
 * (project-workspace-setup.md Step 4 sub-path 3) and reports that nothing
 * exists — without creating a worktree.
 */
export default async function statusNoBranch(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
    project: PROJECT,
    claude,
  });
  await sendInThread(ctx, starter.threadId, "Vas-y.");

  const ticketRe = new RegExp(`\\b${TICKET_ID}\\b`);
  const absenceRe =
    /\b(no branch|aucune branche|pas de branche|pas de worktree|no work|aucun travail|rien (n'a |de |encore|started|encore commenc)|nothing (yet|started|to))\b/i;
  const reportWait = await waitForReport(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === starter.threadId &&
      m.id !== starter.match.id &&
      ticketRe.test(m.text) &&
      absenceRe.test(m.text),
    {
      sinceCursor: starter.nextCursor,
      failFastCliMockGraceMs: 30_000,
    },
  );
  ctx.log({ attachTo: reportWait.entry, label: "no-branch report received" });
  await ctx.judgeLLM({
    attachTo: reportWait.entry,
    message: reportWait.match.text,
    rubric: statusNoBranchRubric(TICKET_ID),
    label: "status-no-branch",
  });

  // project-workspace-setup.md prerequisite: run the delegation manual on every
  // WORK-mode turn — including the no-branch sub-path. The trajectory snapshot
  // flushes when the session run ends, after the report — hence the generous timeout.
  await ctx.waitForAgentToolCall((c) => execMatches(c, /alcode\s+--openclaw-guide\b/), {
    label: "agent runs `alcode --openclaw-guide`",
    timeoutMs: 120_000,
  });

  assertNoWorktreeDirs(ctx);
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
