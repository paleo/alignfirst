import type { ScenarioContext } from "@paleo/openclaw-test";
import { setTimeout } from "node:timers/promises";
import { inputOf } from "./_lib/agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForFinalWorkflowCompletionReport,
} from "./_lib/coding-session.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak } from "./_lib/outbound.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const TICKET_ID = "ABC-0290";
const INSPECT_WAKE = "/opt/alignfirst/alignfirst-developer-tests/scripts/inspect-wake.mjs";

interface WakeObservation {
  terminals: string[];
  toolNames: string[];
  finalizations: number;
  messageCount: number;
  openTurn: boolean;
  observedAt: number;
}

export default async function alreadyReportedWake(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  setupCodingAgentMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);
  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Sur nimbus, ticket ${TICKET_ID}, passe le bouton d'export en gras. ` +
      "Lance directement le travail de code et préviens-moi quand c'est terminé. " +
      "Cette demande se termine après l'implémentation, les tests et la vérification locale : " +
      "ne lance aucune revue de code et n'ouvre aucune PR.",
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
  });
  const claim = await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      call.sessionKey?.toLowerCase().includes(starter.threadId.toLowerCase()) === true,
    { label: "thread session claimed the handoff", timeoutMs: 120_000 },
  );
  const sessionKey = claim.sessionKey;
  if (sessionKey === undefined) throw new Error("Handoff claim has no session attribution");
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId: starter.threadId,
    sinceCursor: starter.nextCursor,
    timeoutMs: 180_000,
    label: "background-started-ack",
  });
  await waitForCodingSessionSucceeded(ctx, { ticketId: TICKET_ID, timeoutMs: 120_000 });
  // The final completion report arrives on the chained `thread-handoff wake` reply run. Wait for
  // the whole requested workflow so the native duplicate cannot race a later verification step.
  await waitForFinalWorkflowCompletionReport(ctx, {
    conversationId: ctx.conversationId,
    threadId: starter.threadId,
    sinceCursor: starter.nextCursor,
    timeoutMs: 420_000,
    label: "completion-before-duplicate-wake",
  });
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor, withinMs: 15_000 });

  // The native exec-exit heartbeat can already be in flight when the final report lands. Let that
  // turn finish before taking the timestamp baseline; otherwise its terminal is misattributed to
  // the duplicate event injected below.
  const before = await waitForWakeQuiescence(ctx, sessionKey);
  ctx.assertEqual(before.finalizations, 0, "handoff and completion needed no isolated finalizer");
  const cursor = await ctx.getCursor();
  // This duplicate follows the native exec-exit notice path: a heartbeat turn that must settle on
  // HEARTBEAT_OK because the chained wake reply run already reported the run.
  const wake = await ctx.execInGateway([
    "openclaw",
    "system",
    "event",
    "--session-key",
    sessionKey,
    "--mode",
    "now",
    "--text",
    "alcode run finished — read its session file and report to the user",
  ]);
  ctx.assertEqual(wake.exitCode, 0, "duplicate completion wake accepted");

  const observed = await waitForWakeTerminal(ctx, sessionKey, before.observedAt);
  ctx.log(`duplicate wake: ${JSON.stringify(observed)}`);
  ctx.assertEqual(
    observed.terminals.every((text) => text.trim() === "HEARTBEAT_OK"),
    true,
    "already-reported wake ends with the heartbeat acknowledgement",
  );
  await ctx.expectNoOutbound(
    (message) => message.direction === "outbound" && message.conversation.id === ctx.conversationId,
    { sinceCursor: cursor, withinMs: 15_000 },
  );
  const after = await inspectWake(ctx, sessionKey, before.observedAt);
  ctx.assertEqual(after.finalizations, 0, "duplicate wake needed no isolated finalizer");
  ctx.assertEqual(
    after.terminals.every((text) => text.trim() === "HEARTBEAT_OK"),
    true,
    "duplicate wake stayed silent through settlement",
  );
  ctx.markScenarioAsEnded("PASS");
}

async function inspectWake(
  ctx: ScenarioContext,
  sessionKey: string,
  since: number,
): Promise<WakeObservation> {
  const result = await ctx.execInGateway(["node", INSPECT_WAKE, sessionKey, String(since)]);
  if (result.exitCode !== 0) throw new Error(`Wake inspection failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function waitForWakeTerminal(
  ctx: ScenarioContext,
  sessionKey: string,
  since: number,
): Promise<WakeObservation> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const observation = await inspectWake(ctx, sessionKey, since);
    if (observation.terminals.length > 0) return observation;
    await setTimeout(1_000);
  }
  throw new Error("Duplicate completion wake never produced a terminal assistant message");
}

async function waitForWakeQuiescence(
  ctx: ScenarioContext,
  sessionKey: string,
): Promise<WakeObservation> {
  const deadline = Date.now() + 180_000;
  let stableCount = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const observation = await inspectWake(ctx, sessionKey, 0);
    if (observation.messageCount !== stableCount || observation.openTurn) {
      stableCount = observation.messageCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3_000) {
      return observation;
    }
    await setTimeout(1_000);
  }
  throw new Error("Thread session did not settle before duplicate completion wake");
}
