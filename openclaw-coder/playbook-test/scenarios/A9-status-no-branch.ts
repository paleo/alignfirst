import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { statusNoBranchRubric } from "./_lib/common-constants.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
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
    senderId: "QAUSER01",
    senderName: "QAUSER01",
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
  ctx.log({
    attachTo: starterWait.entry,
    prefix: `starter received in thread ${threadId}`,
    message: starterWait.match.text,
  });

  const ticketRe = new RegExp(`\\b${TICKET_ID}\\b`);
  const absenceRe =
    /\b(no branch|aucune branche|pas de branche|pas de worktree|no work|aucun travail|rien (n'a |de |encore|started|encore commenc)|nothing (yet|started|to))\b/i;
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === threadId &&
      m.id !== starterWait.match.id &&
      ticketRe.test(m.text) &&
      absenceRe.test(m.text),
    {
      timeoutMs: 120_000,
      sinceCursor: starterWait.nextCursor,
      failFastCliMockGraceMs: 30_000,
      failFastUnmatchedOutbounds: false,
    },
  );
  ctx.log({
    attachTo: reportWait.entry,
    prefix: "no-branch report received",
    message: reportWait.match.text,
  });
  await ctx.judgeLLM({
    attachTo: reportWait.entry,
    message: reportWait.match.text,
    rubric: statusNoBranchRubric(TICKET_ID),
    label: "status-no-branch",
  });

  assertNoWorktreeDirs(ctx);

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
