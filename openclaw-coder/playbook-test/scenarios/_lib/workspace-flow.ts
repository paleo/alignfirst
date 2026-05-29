import type { ScenarioContext } from "@paleo/openclaw-test";
import { assertBranch, waitForWorktreeDir } from "./fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import { expectCodingDelegation, type ClaudeMockHandle } from "./mock-claude.ts";
import type { Step } from "./types.ts";

const WORKSPACE_REPORT_RUBRIC = `A short progress report after the worktree was created. It mentions ALL three: (a) a worktree locator — the directory/path (\`/home/claw/projects/<project>-<ticket>-<type>\` or its tail) OR a slot number (e.g. \`slot 6510\`) is acceptable, since either pinpoints the worktree, (b) the branch name (e.g. \`<ticket>/<type>\`), and (c) the actual current status of the background bootstrap (e.g. "ready", "running", "in progress", "not yet ready"). The message may also include a follow-up announcement of the planned next step or a request for the user's validation — that's fine, but the three required pieces must all be present. Reject if any of (a), (b), or (c) is missing.`;

export interface WorkspaceFlowOptions {
  project: string;
  ticketId: string;
  workType: string;
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
    workType,
    prevStep,
    worktreeTimeoutMs = 120_000,
    reportTimeoutMs = 90_000,
    delegationTimeoutMs = 90_000,
  } = options;

  const worktreeDir = await waitForWorktreeDir(project, ticketId, workType, {
    timeoutMs: worktreeTimeoutMs,
  });
  assertBranch(worktreeDir, `${ticketId}/${workType}`);

  // Skip "preparing…" filler messages: wait for the first outbound that
  // actually references the branch — that's the report we want to judge.
  // The narration-skipping wrapper also discards "Now I'll post the status…"
  // chatter that happens to include the branch.
  const branchRe = new RegExp(`\\b${ticketId}\\/${workType}\\b`, "i");
  const reportWait = await waitForOutboundSkippingNarration(
    ctx,
    (m) =>
      m.direction === "outbound" &&
      m.threadId === prevStep.threadId &&
      m.id !== prevStep.match.id &&
      branchRe.test(m.text),
    { timeoutMs: reportTimeoutMs, sinceCursor: prevStep.nextCursor },
  );
  ctx.log({
    attachTo: reportWait.entry,
    prefix: "workspace report received",
    message: reportWait.match.text,
  });
  await ctx.judgeLLM({
    attachTo: reportWait.entry,
    message: reportWait.match.text,
    rubric: WORKSPACE_REPORT_RUBRIC,
    label: "workspace-report",
  });

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
