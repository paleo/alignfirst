import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForCodingSessionSucceeded, waitForFindingsReport } from "./_lib/coding-session.ts";
import { expectNoProtocolDelegation, setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import {
  assertNoWorktreeDirs,
  bootstrapThreadFromChannel,
  sendInThread,
} from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const QUESTION_TEXT =
  "Sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?";

const INVESTIGATION_FINDING =
  "Investigation finding: handleExport in export-handler.mjs early-returns with a 204 when the region has no comparables, so the response carries no payload at all. The browser treats the empty body as a failed download and the button surfaces it as an error. Fix would be to either render a header-only CSV or surface a 'no comparables' message to the user.";

/**
 * An investigation question hands off like any other work: the channel session
 * opens the thread and stops, even though nothing is missing and no workspace
 * is needed. The thread session recovers the question from the starter's task
 * line — the channel message is invisible to it — and delegates a no-protocol
 * investigation to alcode, in the project dir, with no worktree.
 */
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

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: QUESTION_TEXT,
    project: PROJECT,
    claude,
  });
  await sendInThread(ctx, starter.threadId, "Vas-y.");

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
    threadId: starter.threadId,
    sinceCursor: cursorAfterDelegation,
    timeoutMs: 240_000,
    label: "investigation-summary",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
