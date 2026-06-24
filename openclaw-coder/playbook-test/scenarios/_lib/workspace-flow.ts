import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, readsFile } from "./agent-tool-calls.ts";
import { assertBranch, waitForAnyWorktreeDir } from "./fixture-state.ts";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import { expectCodingDelegation, type ClaudeMockHandle } from "./mock-claude.ts";
import type { Step } from "./types.ts";

// The settled report carries the worktree LOCATOR (dir name or slot) plus the
// branch and a bootstrap-status keyword. These are language-invariant tokens,
// asserted deterministically when the agent posts the block.
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
 * Drive the post-thread-ack phase shared by A1 / A2: wait for the worktree on
 * disk, assert its branch, let the agent settle on its workspace report, unblock
 * it past the step-5 validation gate, then expect the coding delegation. The
 * scenario ends here — the coding stub returns a "test passed, just acknowledge"
 * message so the agent stops cleanly.
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
  // The on-disk check is the deterministic proof that setup happened.
  const { dir: worktreeDir, type: workType } = await waitForAnyWorktreeDir(project, ticketId, {
    timeoutMs: worktreeTimeoutMs,
  });
  assertBranch(worktreeDir, `${ticketId}/${workType}`);

  // Let the agent's setup turn settle on its workspace report BEFORE nudging it
  // — firing "Vas-y" mid-turn disrupts the flow and the agent never reaches the
  // delegation. Select on the worktree LOCATOR so we sync on the settled report,
  // not a pre-creation announcement. The report block is best-effort: assert it
  // when the agent posts it (its format is also covered by A7/A8/A9), tolerate a
  // weak model that reports readiness conversationally and skips the template.
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
  ).catch(() => null);
  if (reportWait) {
    const reportText = reportWait.match.text;
    ctx.log({ attachTo: reportWait.entry, label: "workspace report received" });
    ctx.assertRegex(reportText, locatorRe, "workspace-report: worktree locator (dir or slot)");
    ctx.assertRegex(reportText, branchRe, "workspace-report: branch name");
    ctx.assertRegex(reportText, bootstrapStatusRe, "workspace-report: bootstrap status");
  } else {
    ctx.log(
      "workspace report: no structured block (readiness reported conversationally) — tolerated",
    );
  }

  // Per project-workspace-setup.md Step 5, the agent may pause to ask
  // for validation before delegating coding work. Unblock it unconditionally.
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: "Vas-y, je te laisse faire.",
    threadId: prevStep.threadId,
  });

  await expectCodingDelegation(ctx, claude, {
    ticketId,
    timeoutMs: delegationTimeoutMs,
  });

  // The setup flow's documented prerequisites (project-workspace-setup.md): the
  // agent must read the project's DEVELOPMENT.md — the worktree-setup entry
  // point — and run `workspace --guide` to discover the setup commands. These
  // happen during the setup turn; by now its trajectory has flushed, and
  // waitForAgentToolCall rides out any remaining flush latency.
  await ctx.waitForAgentToolCall((c) => readsFile(c, `${project}/DEVELOPMENT.md`), {
    label: "agent reads the project DEVELOPMENT.md",
  });
  await ctx.waitForAgentToolCall((c) => execMatches(c, /workspace\s+--guide/), {
    label: "agent runs `workspace --guide`",
  });
}
