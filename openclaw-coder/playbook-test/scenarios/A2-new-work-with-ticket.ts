import type { ScenarioContext } from "@paleo/openclaw-test";
import {
  NEW_THREAD_ACK_RUBRIC,
  STARTER_ANNOUNCEMENT_RUBRIC,
  starterLineRegexWithTicket,
} from "./_lib/common-constants.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import type { Step } from "./_lib/types.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-020";
const PROJECT = "nimbus";
const WORK_TYPE = "feat";

export default async function projectDetectionWithTicket(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const starter = await sendRequestWithTicketAndExpectStarter(ctx);
  const ack = await expectAck(ctx, starter);
  await runWorkspaceFlow(ctx, claude, {
    project: PROJECT,
    ticketId: TICKET_ID,
    workType: WORK_TYPE,
    prevStep: ack,
  });

  ctx.log({ attachTo: ack.entry, prefix: "ack received", message: ack.match.text });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function sendRequestWithTicketAndExpectStarter(ctx: ScenarioContext): Promise<Step> {
  const startCursor = await ctx.getCursor();

  await ctx.sendInbound({
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: `Nouvelle fonctionnalité à implémenter sur ${PROJECT} : passer le bouton d'export en gras. Ticket ${TICKET_ID}.`,
  });

  const wait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    // Generous timeout: the bot may still be settling work from a prior
    // scenario; the gateway processes the new conversation in turn.
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const starter = wait.match;
  const threadId = starter.threadId!;
  ctx.log({
    attachTo: wait.entry,
    prefix: `starter received in thread ${threadId}`,
    message: starter.text,
  });

  const lines = starter.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const templateRe = starterLineRegexWithTicket(PROJECT, TICKET_ID);
  const templateIdx = lines.findIndex((l) => templateRe.test(l));
  if (templateIdx === -1) {
    throw new Error(
      `starter does not contain template line matching ${templateRe}; got: ${JSON.stringify(lines)}`,
    );
  }
  const announcement = lines
    .filter((_, i) => i !== templateIdx)
    .join("\n")
    .trim();
  ctx.assertRegex(announcement, /\S/, "starter has content beyond the template line");

  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: announcement,
    rubric: STARTER_ANNOUNCEMENT_RUBRIC,
    label: "starter-announcement",
  });

  return { match: starter, entry: wait.entry, threadId, nextCursor: wait.nextCursor };
}

async function expectAck(ctx: ScenarioContext, prev: Step): Promise<Step> {
  const wait = await waitForOutboundSkippingNarration(
    ctx,
    (m) => m.direction === "outbound" && m.threadId === prev.threadId && m.id !== prev.match.id,
    { timeoutMs: 90_000, sinceCursor: prev.nextCursor },
  );
  ctx.log({ attachTo: wait.entry, prefix: "ack received", message: wait.match.text });

  ctx.assertRegex(wait.match.text, new RegExp(`\\b${TICKET_ID}\\b`), "ack mentions the ticket");
  ctx.assertRegex(wait.match.text, new RegExp(`\\b${PROJECT}\\b`, "i"), "ack mentions the project");

  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: NEW_THREAD_ACK_RUBRIC,
    label: "setup-acknowledgement",
  });

  return {
    match: wait.match,
    entry: wait.entry,
    threadId: prev.threadId,
    nextCursor: wait.nextCursor,
  };
}
