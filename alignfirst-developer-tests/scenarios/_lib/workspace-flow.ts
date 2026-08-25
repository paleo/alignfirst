import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, readsFile } from "./agent-tool-calls.ts";
import { assertBranchForTicket, escapeRegExp, waitForAnyWorktreeDir } from "./fixture-state.ts";
import { isMetaNarration } from "./meta-narration.ts";
import { expectCodingDelegation, type CodingAgentMockHandle } from "./mock-coding-agent.ts";
import type { Step } from "./types.ts";

// The settled report carries the worktree LOCATOR (its directory name, which is
// also the workspace name) plus the branch and a bootstrap-status keyword. These
// are language-invariant tokens, asserted deterministically when the agent posts
// the block.
const bootstrapStatusRe = /\b(ready|running|in[\s-]?progress|failed|ok|prêt|prête|en cours|échou)/i;

export interface WorkspaceFlowOptions {
  projectPath: string;
  ticketId: string;
  prevStep: Step;
  worktreeTimeoutMs?: number;
  reportTimeoutMs?: number;
  delegationTimeoutMs?: number;
}

/**
 * Drive the thread session's setup turn: wait for the worktree on disk, assert
 * its branch, let the agent settle on its workspace report, then expect the
 * coding delegation. The scenario ends here — the coding stub returns a "test
 * passed, just acknowledge" message so the agent stops cleanly.
 *
 * Nothing nudges the agent between the report and the delegation: the user's
 * request is the go-ahead, so a session that pauses for validation fails here.
 */
export async function runWorkspaceFlow(
  ctx: ScenarioContext,
  codingAgent: CodingAgentMockHandle,
  options: WorkspaceFlowOptions,
): Promise<string> {
  const {
    projectPath,
    ticketId,
    prevStep,
    worktreeTimeoutMs = 120_000,
    reportTimeoutMs = 90_000,
    // Covers the documented takeover-sync (fetch, merge, PR check) an agent may
    // legitimately run before delegating.
    delegationTimeoutMs = 150_000,
  } = options;

  // The agent derives the branch description (`{TICKET_ID}/{1-3-words}`); don't
  // pin it. Discover the worktree the agent actually created and read the real
  // branch from git — the worktree DIR name is capped at 22 chars by
  // @paleo/workspace, so it can't reconstruct the branch. The on-disk check is
  // the deterministic proof that setup happened.
  const { dir: worktreeDir } = await waitForAnyWorktreeDir(projectPath, ticketId, {
    timeoutMs: worktreeTimeoutMs,
  });
  const branch = assertBranchForTicket(worktreeDir, ticketId);

  await settleOnWorkspaceReport(ctx, prevStep, worktreeDir, branch, reportTimeoutMs);

  await expectCodingDelegation(ctx, codingAgent, {
    ticketId,
    timeoutMs: delegationTimeoutMs,
  });

  // The setup flow's documented prerequisites (project-workspace-setup.md): the
  // agent must read the project's DEVELOPERS.md — the worktree-setup entry
  // point — and run `workspace --guide` to discover the setup commands. The
  // trajectory snapshot flushes only when a session run ends; when queued
  // inbounds and the exec wake coalesce the whole conversation into one run,
  // the flush trails the completion outbound — hence timeouts well past the
  // 30s default.
  await ctx.waitForAgentToolCall((c) => readsFile(c, `${projectPath}/DEVELOPERS.md`), {
    label: "agent reads the project DEVELOPERS.md",
    timeoutMs: 120_000,
  });
  await ctx.waitForAgentToolCall((c) => execMatches(c, /workspace\s+--guide/), {
    label: "agent runs `workspace --guide`",
    timeoutMs: 120_000,
  });
  return worktreeDir;
}

/**
 * Best-effort check on the workspace report block: assert its shape when the
 * agent posts it, tolerate a session that reports readiness conversationally
 * and skips the template. Its format is pinned by A07/A08/A09, where the report
 * IS the deliverable; on a work request the agent often goes straight to the
 * coding delegation instead.
 *
 * Polls rather than `waitForOutbound`: a wait that times out records a failed
 * entry on the report, which no amount of catching undoes — and the point here
 * is that its absence must not fail the scenario.
 */
export async function settleOnWorkspaceReport(
  ctx: ScenarioContext,
  prevStep: Step,
  worktreeDir: string,
  branch: string,
  budgetMs = 90_000,
): Promise<void> {
  const dirName = worktreeDir.slice(worktreeDir.lastIndexOf("/") + 1);
  const branchRe = new RegExp(`\\b${escapeRegExp(branch)}\\b`, "i");
  const locatorRe = new RegExp(escapeRegExp(dirName), "i");
  const deadline = Date.now() + budgetMs;
  let cursor = prevStep.nextCursor;

  while (Date.now() < deadline) {
    const { messages, nextCursor } = await ctx.poll({ sinceCursor: cursor, timeoutMs: 2_000 });
    cursor = nextCursor;
    for (const m of messages) {
      if (m.direction !== "outbound" || m.threadId !== prevStep.threadId) continue;
      if (m.id === prevStep.match.id || !locatorRe.test(m.text)) continue;
      if (await isMetaNarration(ctx, m.text)) continue;
      ctx.log(`workspace report received: ${JSON.stringify(m.text.slice(0, 160))}`);
      ctx.assertRegex(m.text, locatorRe, "workspace-report: worktree locator (workspace name)");
      ctx.assertRegex(m.text, branchRe, "workspace-report: branch name");
      ctx.assertRegex(m.text, bootstrapStatusRe, "workspace-report: workspace status");
      if (/\[WORKSPACE\]/.test(m.text)) {
        ctx.log("workspace report carries the [WORKSPACE] tag");
      } else {
        ctx.log("workspace report without the [WORKSPACE] tag — tolerated here, pinned by A08");
      }
      return;
    }
  }
  ctx.log(
    "workspace report: no structured block (readiness reported conversationally) — tolerated",
  );
}
