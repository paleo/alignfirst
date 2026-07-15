import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusNoBranchRubric } from "./_lib/common-constants.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, requireThreadId, waitForStarter } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-090";
const PROJECTS_DIR = "/home/claw/projects";

export default async function statusNoBranch(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  setupClaudeMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
  });

  const starterWait = await waitForStarter(ctx, { sinceCursor: startCursor });
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  const ticketRe = new RegExp(`\\b${TICKET_ID}\\b`);
  const absenceRe =
    /\b(no branch|aucune branche|pas de branche|pas de worktree|no work|aucun travail|rien (n'a |de |encore|started|encore commenc)|nothing (yet|started|to))\b/i;
  const isNoBranchReport = (text: string): boolean => ticketRe.test(text) && absenceRe.test(text);

  // No-branch status is WORK-mode but fully scoped: the channel session reads
  // project-workspace-setup.md, detects no branch (Step 4 sub-path 3), and
  // reports "nothing here" in the same turn — ending it. On Slack that turn
  // auto-streams into the thread and the report often rides in the starter
  // message itself. So accept the starter as the report; otherwise wait for a
  // separate one (Discord, or a same-turn follow-up message).
  let reportEntry = starterWait.entry;
  let reportText = starterWait.match.text;
  if (!isNoBranchReport(reportText)) {
    const reportWait = await waitForOutboundSkippingNarration(
      ctx,
      (m) =>
        m.direction === "outbound" &&
        m.threadId === threadId &&
        m.id !== starterWait.match.id &&
        isNoBranchReport(m.text),
      {
        // Match A7/A8: a slow model can take a while to settle the report after
        // the `[WORK]` header (it may attempt setup before concluding no branch).
        timeoutMs: 180_000,
        sinceCursor: starterWait.nextCursor,
        failFastCliMockGraceMs: 30_000,
        failFastUnmatchedOutbounds: false,
      },
    );
    reportEntry = reportWait.entry;
    reportText = reportWait.match.text;
  }
  ctx.log({ attachTo: reportEntry, label: "no-branch report received" });
  await ctx.judgeLLM({
    attachTo: reportEntry,
    message: reportText,
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

function assertNoWorktreeDirs(ctx: ScenarioContext): void {
  if (!existsSync(PROJECTS_DIR)) return;
  const matches = readdirSync(PROJECTS_DIR).filter(
    (entry) => entry.startsWith("nimbus-") || entry.startsWith("lumen-"),
  );
  if (matches.length > 0) {
    throw new Error(`unexpected worktree dirs under ${PROJECTS_DIR}: ${matches.join(", ")}`);
  }
  ctx.log("no worktree dirs created — OK");
}
