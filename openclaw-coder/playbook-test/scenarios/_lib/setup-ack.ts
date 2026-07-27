import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import type { Step } from "./types.ts";

export interface SetupAckOptions {
  threadId: string;
  prevId: string;
  sinceCursor: number;
  timeoutMs?: number;
  maxCandidates?: number;
}

/**
 * Wait for the thread session's setup signal — the short line it posts on
 * entering WORK mode, before the workspace exists (project-workspace-setup.md
 * Step 2).
 *
 * It deliberately restates none of the handoff values: the starter carries them
 * a few messages up, and requiring them twice is what made the agent skip the
 * post entirely. So the only thing recognized here is the commitment to set the
 * workspace up; a chatty pre-ack before it is fine.
 */
export async function waitForSetupAck(ctx: ScenarioContext, opts: SetupAckOptions): Promise<Step> {
  const { threadId, prevId } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const maxCandidates = opts.maxCandidates ?? 5;
  const window: string[] = [];

  let cursor = opts.sinceCursor;
  for (let i = 0; i < maxCandidates; i += 1) {
    const wait = await waitForOutboundSkippingNarration(
      ctx,
      (m) => m.direction === "outbound" && m.threadId === threadId && m.id !== prevId,
      { timeoutMs: Math.max(1000, deadline - Date.now()), sinceCursor: cursor },
    );
    cursor = wait.nextCursor;
    window.push(wait.match.text);
    ctx.log({ attachTo: wait.entry, label: `ack candidate ${i + 1}` });
    if (await commitsToSetup(ctx, wait.match.text)) {
      return {
        match: wait.match,
        entry: wait.entry,
        threadId,
        nextCursor: wait.nextCursor,
      };
    }
    if (Date.now() >= deadline) break;
  }
  throw new Error(
    `setup-acknowledgement: no message committed to workspace setup across ${window.length} candidate(s): ${JSON.stringify(window)}`,
  );
}

async function commitsToSetup(ctx: ScenarioContext, text: string): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ commits: boolean; reason: string }>({
    message: text,
    prompt: `Does this thread message commit to setting up the project workspace — creating or preparing a worktree, branch, or dev environment? Count both present tense ("Je prépare le worktree", "Setting up the workspace") and imminent intent ("Je vais créer la branche", even when it first mentions reading the project docs). A message reporting that the workspace is now ready also counts. Do NOT count a bare process note with no setup commitment ("Je me mets en place", "Je lis le playbook", "Mode WORK").`,
    returnType: '{ "commits": boolean, "reason": string }',
    label: "ack-commits-to-setup",
  });
  return parsed.commits;
}
