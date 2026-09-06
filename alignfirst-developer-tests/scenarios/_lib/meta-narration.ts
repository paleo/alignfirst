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
 * - "Now I'll create the worktree." (unless this is a substantive working-thread status)
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
    prompt: `Classify the message. Return \`isNarration: true\` ONLY when the message is purely the agent narrating internal sequencing (e.g. "Je vais poster…", "Let me first…", "Je dois vérifier…") with no substantive user-facing payload. A fleeting observation used only to justify the next internal step is narration. Likewise, a recap of values collected for itself that ends by announcing creation of the thread is narration. A greeting attached to an internal process note is still narration.

Return \`isNarration: false\` whenever the message carries substantive user-facing content — even if planning or reasoning precedes it. Substantive content includes: an exact thread starter carrying project, ticket, path and task; a working-thread acknowledgement that the requested work has started; status reports with labelled fields; questions for genuinely missing input; findings; or summary deliveries. A content-free request for the user to reply merely to activate a thread is neither valid substantive handoff content nor an acceptable replacement for explicit startup. Tie-breaker: if the observations answer the user's request or report the working thread's admitted task, they are substantive; if they only justify an internal next step, they are narration.`,
    returnType: '{ "isNarration": boolean, "reason": string }',
    label: "meta-narration-classifier",
  });
  return parsed.isNarration;
}

export type OutboundMessage = Parameters<ScenarioContext["waitForOutbound"]>[0] extends (
  m: infer M,
) => unknown
  ? M
  : never;

/**
 * Like `ctx.waitForOutbound`, but messages classified as meta-narration are
 * logged and skipped — the wait re-enters until a non-narration outbound
 * matches the predicate or the timeout elapses.
 *
 * The starter wait rides this too (via `waitForStarter`): unphased providers
 * (qwen/glm) stream planning notes into the auto-thread ahead of the starter,
 * so a session whose only thread output is narration times out instead of
 * failing the starter asserts on a planning note.
 */
export async function waitForOutboundSkippingNarration(
  ctx: ScenarioContext,
  predicate: (m: OutboundMessage) => boolean,
  opts: WaitForOutboundOptions,
): Promise<WaitForOutboundResult> {
  let cursor = opts.sinceCursor;
  const effectiveTimeoutMs = opts.timeoutMs ?? 1000;
  const deadline = Date.now() + effectiveTimeoutMs;
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
    ctx.log({ attachTo: wait.entry, label: "meta-narration skipped" });
    cursor = wait.nextCursor;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForOutboundSkippingNarration: only narration matched within ${effectiveTimeoutMs}ms`,
      );
    }
  }
}
