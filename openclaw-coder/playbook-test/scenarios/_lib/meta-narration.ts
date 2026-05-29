import type {
  ScenarioContext,
  WaitForOutboundOptions,
  WaitForOutboundResult,
} from "@paleo/openclaw-test";

/**
 * True iff `text` reads as the agent narrating its plan or intent rather than
 * delivering substantive user-facing content. Examples of narration:
 *
 * - "Je vais poster l'accusé de réception puis lancer le worktree."
 * - "Let me first check the project, then I'll open a thread."
 * - "Now I'll create the worktree."
 *
 * Substantive content (templated starters, status reports, asks for input,
 * acknowledgements) returns `false`.
 *
 * Backed by a cheap LLM classifier — only invoked when the scenario chooses to
 * gate on it, so usual scenario cost stays at the same single judge call.
 */
export async function isMetaNarration(ctx: ScenarioContext, text: string): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ isNarration: boolean; reason: string }>({
    message: text,
    prompt: `Classify the message. Return \`isNarration: true\` ONLY when the message is purely the agent narrating its plan or intent (e.g. "Je vais poster…", "Let me first…", "Now I'll…", "Je dois vérifier…", "Checking the project then…") with no substantive user-facing payload.

Return \`isNarration: false\` whenever the message carries substantive user-facing content — even if a planning sentence is appended. Substantive content includes: templated starter lines (\`Project: **X** — Ticket: **Y** — …\`), acknowledgements that restate the project + ticket, status reports with labelled fields (e.g. \`Worktree: …\`, \`Branche: …\`, \`Bootstrap: …\`), questions to the user, or summary deliveries.`,
    returnType: '{ "isNarration": boolean, "reason": string }',
    label: "meta-narration-classifier",
  });
  return parsed.isNarration;
}

type OutboundMessage = Parameters<ScenarioContext["waitForOutbound"]>[0] extends (
  m: infer M,
) => unknown
  ? M
  : never;

/**
 * Like `ctx.waitForOutbound`, but messages classified as meta-narration are
 * logged and skipped — the wait re-enters until a non-narration outbound
 * matches the predicate or the timeout elapses.
 *
 * Do NOT use this for the starter wait: a starter that's narration should
 * fail the scenario, not be silently skipped.
 */
export async function waitForOutboundSkippingNarration(
  ctx: ScenarioContext,
  predicate: (m: OutboundMessage) => boolean,
  opts: WaitForOutboundOptions,
): Promise<WaitForOutboundResult> {
  let cursor = opts.sinceCursor;
  const deadline = Date.now() + (opts.timeoutMs ?? 1000);
  for (;;) {
    const remaining = Math.max(1000, deadline - Date.now());
    const wait = await ctx.waitForOutbound(predicate, {
      timeoutMs: remaining,
      sinceCursor: cursor,
      failFastUnmatchedOutbounds: opts.failFastUnmatchedOutbounds,
      failFastCliMockGraceMs: opts.failFastCliMockGraceMs,
    });
    if (!(await isMetaNarration(ctx, wait.match.text))) {
      return wait;
    }
    ctx.log({
      attachTo: wait.entry,
      prefix: "meta-narration skipped",
      message: wait.match.text,
    });
    cursor = wait.nextCursor;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForOutboundSkippingNarration: only narration matched within ${opts.timeoutMs}ms`,
      );
    }
  }
}
