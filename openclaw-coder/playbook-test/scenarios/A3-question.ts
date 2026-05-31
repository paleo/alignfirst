import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext, WaitForOutboundResult } from "@paleo/openclaw-test";
import { INVESTIGATION_SUMMARY_RUBRIC } from "./_lib/common-constants.ts";
import { expectNoProtocolDelegation, setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const PROJECTS_DIR = "/home/claw/projects";
const QUESTION_TEXT =
  "Sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?";

const INVESTIGATION_FINDING =
  "Investigation finding: the export handler in app.mjs early-returns when the comparables array is empty, so the response stream closes before any payload is written. The client receives a 204 and the button surfaces it as a failure. Fix would be to either render an empty-state CSV or surface a 'no comparables' message to the user.";

export default async function projectInvestigationQuestion(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx, { defaultResult: INVESTIGATION_FINDING });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: QUESTION_TEXT,
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

  const delegationCall = await expectNoProtocolDelegation(ctx, claude, {
    rubric: `The captured invocation is a prompt sent to a coding agent via the alignfirst-coaching wrapper, **without** an alignfirst protocol header. Expected: an investigation/question delegation that conveys the user's question (export button failure when there are no comparables — paraphrases are fine) and signals "do not implement / talk first" (or equivalent). Do not judge the project or working directory — that is asserted structurally. Reject only if: the prompt looks like an alignfirst protocol invocation (\`Run the _spec_ protocol …\` etc.), or the question content is missing or unrelated.`,
    label: "claude-investigation-delegation",
  });
  // The delegation must run in the project dir so the coding agent investigates
  // the right repo — checked structurally (deterministic), not by the judge.
  ctx.assertRegex(
    delegationCall.cwd,
    /^\/home\/claw\/projects\/nimbus\/?$/,
    "delegation runs from the nimbus project directory",
  );
  const cursorAfterDelegation = await ctx.getCursor();
  ctx.log(
    `no-protocol delegation captured (argv[0] length=${delegationCall.argv[0]?.length ?? 0})`,
  );

  assertNoWorktreeDirs(ctx);

  // The summary post arrives *after* the claude mock returns. Wait for the
  // first outbound in the thread strictly after the delegation completes.
  const summary = await waitForSummary(ctx, threadId, cursorAfterDelegation);
  await ctx.judgeLLM({
    attachTo: summary.entry,
    message: summary.match.text,
    rubric: INVESTIGATION_SUMMARY_RUBRIC,
    label: "investigation-summary",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function waitForSummary(
  ctx: ScenarioContext,
  threadId: string,
  sinceCursor: number,
): Promise<WaitForOutboundResult> {
  const wait = await ctx.waitForOutbound(
    (m) => m.direction === "outbound" && m.threadId === threadId,
    { timeoutMs: 90_000, sinceCursor, failFastCliMockGraceMs: 30_000 },
  );
  ctx.log({
    attachTo: wait.entry,
    prefix: "post-delegation message received",
    message: wait.match.text,
  });
  return wait;
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
