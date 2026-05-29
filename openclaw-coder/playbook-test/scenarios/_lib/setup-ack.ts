import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import type { Step } from "./types.ts";

export interface SetupAckOptions {
  threadId: string;
  prevId: string;
  sinceCursor: number;
  ticketId: string;
  project: string;
  timeoutMs?: number;
  maxCandidates?: number;
}

/**
 * Wait for the agent to acknowledge a newly-supplied ticket by committing to
 * setting up the workspace. The agent may post a brief filler first ("je m'y
 * mets", "je lis le playbook") before the substantive ack — that doesn't harm
 * the goal, so we judge the ack window and pass as soon as one message commits
 * to setup. Project + ticket are checked deterministically over the window.
 */
export async function waitForSetupAck(ctx: ScenarioContext, opts: SetupAckOptions): Promise<Step> {
  const { threadId, prevId, ticketId, project } = opts;
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
    ctx.log({ attachTo: wait.entry, prefix: `ack candidate ${i + 1}`, message: wait.match.text });
    if (await commitsToSetup(ctx, wait.match.text)) {
      const joined = window.join("\n");
      ctx.assertRegex(joined, new RegExp(`\\b${ticketId}\\b`), "ack window states the ticket");
      ctx.assertRegex(joined, new RegExp(`\\b${project}\\b`, "i"), "ack window names the project");
      return { match: wait.match, entry: wait.entry, threadId, nextCursor: wait.nextCursor };
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
    prompt: `Does this thread message commit to setting up the project workspace — creating or preparing a worktree, branch, or dev environment? Count both present tense ("Je prépare le worktree", "Setting up the workspace") and imminent intent ("Je vais créer la branche", even when it first mentions reading the project docs). Do NOT count a bare process note with no setup commitment ("Je me mets en place", "Je lis le playbook", "Mode WORK") or a message claiming the coding work is already finished.`,
    returnType: '{ "commits": boolean, "reason": string }',
    label: "ack-commits-to-setup",
  });
  return parsed.commits;
}
