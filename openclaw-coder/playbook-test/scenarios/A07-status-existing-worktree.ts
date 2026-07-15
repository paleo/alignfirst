import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { statusExistingWorktreeRubric } from "./_lib/common-constants.ts";
import { seedWorktree, worktreePath } from "./_lib/fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, requireThreadId, waitForStarter } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-070";
const BRANCH_DESC = "export-bold";
const BRANCH = `${TICKET_ID}/${BRANCH_DESC}`;
const PROJECTS_DIR = "/home/claw/projects";

export default async function statusExistingWorktree(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  setupClaudeMock(ctx);
  setupGhMock(ctx);

  const seededPath = await seedWorktree(ctx, PROJECT, TICKET_ID, BRANCH_DESC);
  ctx.log(`pre-seeded worktree at ${seededPath}`);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Où en est ${TICKET_ID} sur ${PROJECT} ?`,
  });

  const starterWait = await waitForStarter(ctx, { sinceCursor: startCursor });
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  // The report text is matched at conversation level on purpose: free-form text
  // after `thread-create` auto-streams to the parent channel, and a thread-scoped
  // predicate would only reveal that leak as a timeout. Match the text, then
  // assert placement — a leaked report fails fast with the real cause.
  const branchRe = new RegExp(
    `\\b${TICKET_ID}/${BRANCH_DESC}\\b|nimbus-${TICKET_ID}-${BRANCH_DESC}\\b`,
  );
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.id !== starterWait.match.id &&
      branchRe.test(m.text),
    {
      timeoutMs: 180_000,
      sinceCursor: starterWait.nextCursor,
      failFastCliMockGraceMs: 30_000,
      failFastUnmatchedOutbounds: false,
    },
  );
  ctx.log({ attachTo: reportWait.entry, label: "status report received" });
  ctx.assertEqual(reportWait.match.threadId, threadId, "status report posted in the thread");
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
  assertOnlySeededWorktreeDir(ctx);
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function assertOnlySeededWorktreeDir(ctx: ScenarioContext): void {
  if (!existsSync(PROJECTS_DIR)) return;
  const expected = worktreePath(PROJECT, TICKET_ID, BRANCH_DESC).slice(PROJECTS_DIR.length + 1);
  const extras = readdirSync(PROJECTS_DIR).filter(
    (entry) => (entry.startsWith("nimbus-") || entry.startsWith("lumen-")) && entry !== expected,
  );
  if (extras.length > 0) {
    throw new Error(`unexpected extra worktree dirs under ${PROJECTS_DIR}: ${extras.join(", ")}`);
  }
  ctx.log("only the seeded worktree present — OK");
}
