import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import type { Step } from "./_lib/types.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-020";
const PROJECT = "nimbus";

export default async function projectDetectionWithTicket(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const ack = await sendRequestWithTicketAndExpectWorkHeader(ctx);
  await runWorkspaceFlow(ctx, claude, {
    project: PROJECT,
    ticketId: TICKET_ID,
    prevStep: ack,
  });

  ctx.log({ attachTo: ack.entry, prefix: "[WORK] header received", message: ack.match.text });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function sendRequestWithTicketAndExpectWorkHeader(ctx: ScenarioContext): Promise<Step> {
  const startCursor = await ctx.getCursor();

  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. Ticket ${TICKET_ID}.`,
  });

  // The thread opens with the first outbound. Under Slack auto-threading the
  // first auto-streamed text becomes the starter, so a weak model may leak its
  // reasoning here, or merge the announcement and the `[WORK]` header into one
  // message — both tolerated. We don't judge the starter's form; we scan from
  // it (inclusive) for the `[WORK]` header, the durable project/ticket carrier
  // and the real outcome.
  const wait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    // Generous timeout: the bot may still be settling work from a prior
    // scenario; the gateway processes the new conversation in turn.
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(wait);
  ctx.log({
    attachTo: wait.entry,
    prefix: `starter received in thread ${threadId}`,
    message: wait.match.text,
  });
  const starter: Step = {
    match: wait.match,
    entry: wait.entry,
    threadId,
    nextCursor: wait.nextCursor,
  };

  return await waitForSetupAck(ctx, {
    threadId,
    prevId: wait.match.id,
    sinceCursor: wait.nextCursor,
    ticketId: TICKET_ID,
    project: PROJECT,
    audience: "tech",
    seedCandidate: starter,
  });
}
