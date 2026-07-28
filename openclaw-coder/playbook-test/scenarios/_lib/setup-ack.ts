import type { ScenarioContext } from "@paleo/openclaw-test";
import type { Step } from "./types.ts";

export interface SetupAckOptions {
  threadId: string;
  prevId: string;
  sinceCursor: number;
  timeoutMs?: number;
  maxCandidates?: number;
}

/**
 * Wait for the thread session's first post showing it has taken over the work.
 *
 * With an Anthropic model, mid-turn text never delivers (see "Auto-stream delivers turn finals
 * only on Anthropic" in `docs/openclaw-coder/openclaw-context-engineering.md`): the WORK turn's
 * only guaranteed post is its end-of-turn message, which may consolidate the workspace state,
 * the delegation launch, or even the completed outcome. On Discord a `message` rename post can
 * arrive earlier. All of these count; the judge accepts any message that shows the takeover.
 *
 * The delegation (a `claude` cliMock via alcode) legitimately fires BEFORE any thread post on
 * finals-only surfaces, so the cliMock fail-fast is disabled — the deadline bounds the wait.
 *
 * No meta-narration pre-filter: the setup signal is a bare intent line by design ("Je prépare le
 * workspace."), exactly the shape the narration classifier flags — it ate the signal before
 * `commitsToSetup` could see it (A02, artifacts 2026-07-28T04-43-26). The candidate loop already
 * skips anything that doesn't commit.
 *
 * The candidate cap must absorb unphased providers (qwen/glm), which stream every mid-turn
 * planning note into the thread: 5 candidates were all narration on glm-5.2 while the real ack
 * was still coming (A01, artifacts 2026-07-28T09-01-38). The deadline is the real bound.
 */
export async function waitForSetupAck(ctx: ScenarioContext, opts: SetupAckOptions): Promise<Step> {
  const { threadId, prevId } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const maxCandidates = opts.maxCandidates ?? 15;
  const window: string[] = [];

  let cursor = opts.sinceCursor;
  for (let i = 0; i < maxCandidates; i += 1) {
    const wait = await ctx.waitForOutbound(
      (m) => m.direction === "outbound" && m.threadId === threadId && m.id !== prevId,
      {
        timeoutMs: Math.max(1000, deadline - Date.now()),
        sinceCursor: cursor,
        failFastCliMockGraceMs: false,
      },
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
    `setup-acknowledgement: no message committed to the work across ${window.length} candidate(s): ${JSON.stringify(window)}`,
  );
}

async function commitsToSetup(ctx: ScenarioContext, text: string): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ commits: boolean; reason: string }>({
    message: text,
    prompt: `Does this thread message show the assistant has taken over the work? Count: committing to or reporting workspace setup — creating or preparing a worktree, branch, or dev environment ("Je prépare le worktree", "Setting up the workspace", "Worktree: … Bootstrap: ready"); telling the user the work is launched or underway, possibly in the background ("Je lance l'agent de code", "the coding agent is running — I'll report back"); or reporting the work's outcome. Count both present tense and imminent intent. Do NOT count a bare process note with no commitment ("Je me mets en place", "Je lis le playbook", "Mode WORK"), or a platform error notice ("⚠️ …").`,
    returnType: '{ "commits": boolean, "reason": string }',
    label: "ack-commits-to-setup",
  });
  return parsed.commits;
}
