import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForCodingSessionSucceeded, waitForFindingsReport } from "./_lib/coding-session.ts";
import { expectNoProtocolDelegation, setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId, waitForStarter } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const PROJECTS_DIR = "/home/claw/projects";
const QUESTION_TEXT =
  "Sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?";

const INVESTIGATION_FINDING =
  "Investigation finding: the export handler in app.mjs early-returns when the comparables array is empty, so the response stream closes before any payload is written. The client receives a 204 and the button surfaces it as a failure. Fix would be to either render an empty-state CSV or surface a 'no comparables' message to the user.";

export default async function projectInvestigationQuestion(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // streamDelayMs keeps the mock coding run alive past the launching turn (real runs take
  // minutes+): an exec that exits mid-turn gets its exit event consumed by the in-flight turn and
  // the completion wake never fires as its own turn — a fixture artifact, not a product behavior.
  const claude = setupClaudeMock(ctx, {
    defaultResult: INVESTIGATION_FINDING,
    streamDelayMs: 12_000,
  });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: QUESTION_TEXT,
  });

  const starterWait = await waitForStarter(ctx, { sinceCursor: startCursor });
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  const { call: delegationCall, cursorAfterDelegation } = await expectNoProtocolDelegation(
    ctx,
    claude,
    {
      rubric: `The captured invocation is a prompt sent to a coding agent via the alcode CLI, **without** an alignfirst protocol header. Expected: an investigation/question delegation that conveys the user's question (export button failure when there are no comparables — paraphrases are fine) and signals "do not implement / talk first" (or equivalent). Do not judge the project or working directory — that is asserted structurally. Reject only if: the prompt looks like an alignfirst protocol invocation (\`Run the _spec_ protocol …\` etc.), or the question content is missing or unrelated.`,
      label: "claude-investigation-delegation",
    },
  );
  // The delegation must run in the project dir so the coding agent investigates
  // the right repo — checked structurally (deterministic), not by the judge.
  ctx.assertRegex(
    delegationCall.cwd,
    /^\/home\/claw\/projects\/nimbus\/?$/,
    "delegation runs from the nimbus project directory",
  );
  ctx.log(
    `no-protocol delegation captured (argv[0] length=${delegationCall.argv[0]?.length ?? 0})`,
  );

  assertNoWorktreeDirs(ctx);

  // The guide makes every alcode run a background task, so the findings arrive only after the
  // exec-exit wake: launch ack first, then the session file reaches `status: succeeded` (no-ticket
  // run → `.plans/_alcode/`), then the woken agent relays the finding in the thread.
  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, { timeoutMs: 120_000 });
  ctx.log(`coding-session file succeeded: ${sessionFilePath}`);

  // The findings arrive only after the exec-exit wake; a batch judge picks the relayed finding out
  // of the thread window, ignoring the earlier launch ack (see `waitForFindingsReport`).
  await waitForFindingsReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: cursorAfterDelegation,
    timeoutMs: 240_000,
    label: "investigation-summary",
  });

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
