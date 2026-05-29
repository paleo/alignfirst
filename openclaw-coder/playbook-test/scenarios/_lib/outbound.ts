import type { WaitForOutboundResult } from "@paleo/openclaw-test";

/**
 * The starter and its follow-ups always arrive inside a thread. Narrow the
 * optional `threadId` for the type system, failing loudly if the bus ever
 * delivers a thread-less match.
 */
export function requireThreadId(wait: WaitForOutboundResult): string {
  const { threadId, id } = wait.match;
  if (threadId === undefined) {
    throw new Error(`expected outbound message ${id} to carry a threadId`);
  }
  return threadId;
}
