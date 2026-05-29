import type { ScenarioContext } from "@paleo/openclaw-test";
import { assertBranch, waitForAnyWorktreeDir } from "./fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import { expectCodingDelegation, type ClaudeMockHandle } from "./mock-claude.ts";
import type { Step } from "./types.ts";

// The worktree report is a fixed labelled template (`Worktree: … / Branch: …
// / Bootstrap: …`, translated to the user's language). Its three required
// pieces are language-invariant tokens — the worktree dir name (or a slot
// number), the branch, and a bootstrap-status keyword — so assert them
// deterministically. A cheap LLM judge proved unreliable here, returning false
// negatives on a report that plainly carried all three fields.
const bootstrapStatusRe = /\b(ready|running|in[\s-]?progress|failed|prêt|prête|en cours|échou)/i;

export interface WorkspaceFlowOptions {
  project: string;
  ticketId: string;
  prevStep: Step;
  worktreeTimeoutMs?: number;
  reportTimeoutMs?: number;
  delegationTimeoutMs?: number;
}

/**
 * Drive the post-thread-ack phase shared by A1 / A2: wait for the worktree,
 * assert its branch, expect a status report (worktree dir + branch + bootstrap
 * status), unblock the agent past the step-5 validation gate, then expect the
 * coding delegation. The scenario ends here — the coding stub returns a
 * "test passed, just acknowledge" message so the agent stops cleanly.
 */
export async function runWorkspaceFlow(
  ctx: ScenarioContext,
  claude: ClaudeMockHandle,
  options: WorkspaceFlowOptions,
): Promise<void> {
  const {
    project,
    ticketId,
    prevStep,
    worktreeTimeoutMs = 120_000,
    reportTimeoutMs = 90_000,
    delegationTimeoutMs = 90_000,
  } = options;

  // The agent chooses the work type (feat/fix/refactor…); don't pin it. Discover
  // the worktree the agent actually created and derive the type from its name.
  const { dir: worktreeDir, type: workType } = await waitForAnyWorktreeDir(project, ticketId, {
    timeoutMs: worktreeTimeoutMs,
  });
  assertBranch(worktreeDir, `${ticketId}/${workType}`);

  // The settled report carries the worktree LOCATOR (dir name or slot); a
  // pre-creation announcement ("Je crée la branche ABC-010/fix et le worktree")
  // carries only the branch. Select on the locator so we judge the settled
  // report, not the announcement that precedes it.
  const branchRe = new RegExp(`\\b${ticketId}\\/${workType}\\b`, "i");
  const locatorRe = new RegExp(`${project}-${ticketId}-${workType}|slot\\s*\\d{3,5}`, "i");
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === prevStep.threadId &&
      m.id !== prevStep.match.id &&
      locatorRe.test(m.text),
    { timeoutMs: reportTimeoutMs, sinceCursor: prevStep.nextCursor },
  );
  ctx.log({
    attachTo: reportWait.entry,
    prefix: "workspace report received",
    message: reportWait.match.text,
  });
  // (a) worktree locator — selected on above; (b) branch; (c) bootstrap status.
  const reportText = reportWait.match.text;
  ctx.assertRegex(reportText, locatorRe, "workspace-report: worktree locator (dir or slot)");
  ctx.assertRegex(reportText, branchRe, "workspace-report: branch name");
  ctx.assertRegex(reportText, bootstrapStatusRe, "workspace-report: bootstrap status");

  // Per project-workspace-setup.md Step 5, the agent may pause to ask
  // for validation before delegating coding work. Unblock it unconditionally.
  await ctx.sendInbound({
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: "Vas-y, je te laisse faire.",
    threadId: prevStep.threadId,
  });

  await expectCodingDelegation(ctx, claude, {
    ticketId,
    timeoutMs: delegationTimeoutMs,
  });
}
