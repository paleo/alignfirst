import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { statusExistingWorktreeRubric } from "./_lib/common-constants.ts";
import { seedWorktree, worktreePath } from "./_lib/fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
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

  const starterWait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  // Accept the report in the thread OR auto-streamed to the parent channel —
  // some iterations of the agent emit free-form text after thread-create which
  // auto-streams to the channel. Per the playbook-test README.md tolerance, the user still sees it.
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
  await ctx.judgeLLM({
    attachTo: reportWait.entry,
    message: reportWait.match.text,
    rubric: statusExistingWorktreeRubric(TICKET_ID, BRANCH),
    label: "status-existing-worktree",
  });

  assertOnlySeededWorktreeDir(ctx);

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
