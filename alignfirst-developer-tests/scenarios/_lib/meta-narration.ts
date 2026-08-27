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
    prompt: `Classify the message. Return \`isNarration: true\` ONLY when the message is purely the agent narrating its plan or intent (e.g. "Je vais poster…", "Let me first…", "Now I'll…", "Je dois vérifier…", "Checking the project then…") with no substantive user-facing payload. A fleeting progress observation that only sets up the announced next step ("Pas de branche existante — je crée la branche", "Pas de remote configuré, je passe à la création du workspace", "Fetch OK. Je lance la suite") is still narration, even when it stacks several such observations: it reports preconditions of the agent's own next action, not something the user asked for. Likewise, a recap of values the agent collected for itself (project, ticket, task — labelled fields included) that ends by announcing the agent's own next action ("Now I'll open the thread", "J'ouvre le fil") and asks nothing of the user is narration: it is the agent thinking out loud before acting, not a delivery. Example, still narration despite the labelled values: "Projet: nimbus, Ticket: ABC-070. Je crée le thread." A greeting or brief on-it acknowledgement attached to plan narration ("Salut Robin ! Je vais regarder ça. Laisse-moi d'abord charger mon playbook.") is also narration — addressing the user by name does not make an intent note substantive.

Return \`isNarration: false\` whenever the message carries substantive user-facing content — even if a planning sentence is appended or reasoning precedes it. Substantive content includes: templated starter lines (\`Project: **X** — Ticket: **Y** — …\`) that address the user, end on a question or request to them, or end by telling the user their next message launches the work / the thread session ("La session du thread sera lancée par le prochain message." — a handoff to the user, NOT the agent announcing its own action, so it is substantive even glued after collected-values reasoning); acknowledgements that restate the project + ticket for the user; status reports with labelled fields (e.g. \`[WORKSPACE] …\`, \`Worktree: …\`, \`Branche: …\`, \`Status: …\`); questions to the user; or summary deliveries. Tie-breaker: if the observations are themselves the answer the user is waiting for (e.g. the user asked for a status and the message reports findings like an open PR or branch state), or the message asks the user for something, it is substantive; if it merely justifies the agent's next step, it is narration.`,
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
