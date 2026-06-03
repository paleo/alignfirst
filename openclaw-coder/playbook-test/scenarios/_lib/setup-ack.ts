import type { ScenarioContext } from "@paleo/openclaw-test";
import { workHeaderRegex } from "./common-constants.ts";
import { waitForOutboundSkippingNarration } from "./meta-narration.ts";
import type { Step } from "./types.ts";

export interface SetupAckOptions {
  threadId: string;
  prevId: string;
  sinceCursor: number;
  ticketId: string;
  project: string;
  /** When set, require the `[WORK]` header and assert its audience token. */
  audience?: "tech" | "non-tech";
  timeoutMs?: number;
  maxCandidates?: number;
}

/**
 * Wait for the agent to acknowledge a newly-supplied ticket by committing to
 * setting up the workspace.
 *
 * With `audience` set, the WORK-entry ack IS the `[WORK]` header — so we scan
 * candidates until one matches it (the header carries project + ticket +
 * audience), tolerating any chatty pre-ack the agent posts first. Without it,
 * the agent may post a brief filler before the substantive ack, so we judge the
 * ack window and pass as soon as one message commits to setup.
 */
export async function waitForSetupAck(ctx: ScenarioContext, opts: SetupAckOptions): Promise<Step> {
  const { threadId, prevId, ticketId, project } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const maxCandidates = opts.maxCandidates ?? 5;
  const headerRe = workHeaderRegex(project, ticketId);
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

    if (opts.audience) {
      if (headerRe.test(wait.match.text)) {
        assertWorkHeaderAudience(wait.match.text, opts.audience);
        return { match: wait.match, entry: wait.entry, threadId, nextCursor: wait.nextCursor };
      }
    } else if (await commitsToSetup(ctx, wait.match.text)) {
      const joined = window.join("\n");
      ctx.assertRegex(joined, new RegExp(`\\b${ticketId}\\b`), "ack window states the ticket");
      ctx.assertRegex(joined, new RegExp(`\\b${project}\\b`, "i"), "ack window names the project");
      return { match: wait.match, entry: wait.entry, threadId, nextCursor: wait.nextCursor };
    }
    if (Date.now() >= deadline) break;
  }
  const what = opts.audience ? "no [WORK] header" : "no message committed to workspace setup";
  throw new Error(
    `setup-acknowledgement: ${what} across ${window.length} candidate(s): ${JSON.stringify(window)}`,
  );
}

// The `[WORK]` header names the audience with a literal `tech` / `non-tech`
// token (kept intact across languages), so check it by token rather than by an
// LLM judge. "non-tech" contains "tech", so the tech case must also exclude it.
function assertWorkHeaderAudience(text: string, expected: "tech" | "non-tech"): void {
  const hasNonTech = /non-?tech/i.test(text);
  if (expected === "non-tech") {
    if (!hasNonTech) {
      throw new Error(`[WORK] header audience: expected non-tech, got: ${JSON.stringify(text)}`);
    }
    return;
  }
  if (hasNonTech || !/\btech\b/i.test(text)) {
    throw new Error(`[WORK] header audience: expected tech, got: ${JSON.stringify(text)}`);
  }
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
