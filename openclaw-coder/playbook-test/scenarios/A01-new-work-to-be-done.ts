import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe, NEW_WORK_QUESTION_RUBRIC } from "./_lib/common-constants.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId, waitForStarter } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { waitForSetupAck } from "./_lib/setup-ack.ts";
import type { Step } from "./_lib/types.ts";
import { runWorkspaceFlow } from "./_lib/workspace-flow.ts";

const TICKET_ID = "ABC-010";
const PROJECT = "nimbus";

interface StarterStep extends Step {
  questionAlreadyAsked: boolean;
}

export default async function projectDetectionStarter(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const starter = await sendInitialRequestAndExpectStarter(ctx);
  const beforeAck: Step = starter.questionAlreadyAsked
    ? starter
    : await expectTicketQuestion(ctx, starter);
  const ack = await sendTicketAndExpectAck(ctx, beforeAck);
  await runWorkspaceFlow(ctx, claude, {
    project: PROJECT,
    ticketId: TICKET_ID,
    prevStep: ack,
  });

  ctx.log({ attachTo: ack.entry, label: "ack received" });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function sendInitialRequestAndExpectStarter(ctx: ScenarioContext): Promise<StarterStep> {
  const startCursor = await ctx.getCursor();

  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: "Nous avons un travail à faire sur nimbus.",
  });

  // First thread outbound is the starter. Pre-thread channel narration is
  // tolerated (see waitForStarter): the agent still opens the thread.
  const wait = await waitForStarter(ctx, { sinceCursor: startCursor });
  const starter = wait.match;
  const threadId = requireThreadId(wait);
  ctx.log({ attachTo: wait.entry, label: `starter received in thread ${threadId}` });

  // The starter has no ticket/role header (TICKET_ID is still unknown; the
  // `[WORK]` header appears only once it's supplied). On Discord it must NAME
  // the project — a fresh Discord thread session can't see the channel message
  // that named it, so the starter is the only pre-`[WORK]` carrier. On Slack
  // the auto-threaded triggering message is in the thread history, so the
  // project survives even when the starter is reasoning leak that omits it.
  if (ctx.channel === "discord-mock") {
    ctx.assertRegex(
      starter.text,
      new RegExp(escapeRe(PROJECT), "i"),
      "starter names the project (Discord recovery carrier)",
    );
  }
  // The agent may instead use the in-starter shortcut and ask about the work.
  const questionAlreadyAsked = await classifyStarterRest(ctx, wait.entry, starter.text.trim());

  return {
    match: starter,
    entry: wait.entry,
    threadId,
    nextCursor: wait.nextCursor,
    questionAlreadyAsked,
  };
}

async function classifyStarterRest(
  ctx: ScenarioContext,
  entry: import("@paleo/openclaw-test").OutboundReceivedEntry,
  rest: string,
): Promise<boolean> {
  // Branch on whether the starter body already asks the user about the new
  // work (the in-starter shortcut). Non-throwing JSON judge so we can branch;
  // the chosen branch then validates with the matching rubric.
  const classification = await ctx.judgeLLMJson<{
    asksAboutTheWork: boolean;
    reason: string;
  }>({
    message: rest,
    prompt:
      "Does the message ask the user about the new work? That includes requesting the ticket id, the change scope/description, or any combination. Answer true only when the message clearly puts a request to the user about that. A bare announcement or filler phrase is not a request.",
    returnType: `{ "asksAboutTheWork": boolean, "reason": string }`,
    label: "starter-asks-about-work",
  });

  const asksAboutTheWork = classification.parsed.asksAboutTheWork;
  ctx.log({
    attachTo: entry,
    label: "starter-rest classified",
    extra: { asksAboutTheWork, reason: classification.parsed.reason },
  });

  // When the starter already asks about the work, validate that ask. Otherwise
  // it's an announcement-only starter (or tolerated reasoning leak) — nothing
  // to judge here; the separate follow-up question is validated downstream.
  if (asksAboutTheWork) {
    await ctx.judgeLLM({
      attachTo: entry,
      message: rest,
      rubric: NEW_WORK_QUESTION_RUBRIC,
      label: "starter-work-question",
    });
  }
  return asksAboutTheWork;
}

async function expectTicketQuestion(ctx: ScenarioContext, prev: StarterStep): Promise<Step> {
  const wait = await waitForOutboundSkippingNarration(
    ctx,
    (m) => m.direction === "outbound" && m.threadId === prev.threadId && m.id !== prev.match.id,
    { timeoutMs: 45_000, sinceCursor: prev.nextCursor },
  );
  ctx.log({ attachTo: wait.entry, label: "follow-up received" });

  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric: NEW_WORK_QUESTION_RUBRIC,
    label: "follow-up-work-question",
  });

  return {
    match: wait.match,
    entry: wait.entry,
    threadId: prev.threadId,
    nextCursor: wait.nextCursor,
  };
}

async function sendTicketAndExpectAck(ctx: ScenarioContext, prev: Step): Promise<Step> {
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Ticket ${TICKET_ID}. La fonctionnalité dont nous avons besoin : passer le bouton d'export en gras.`,
    threadId: prev.threadId,
  });

  return await waitForSetupAck(ctx, {
    threadId: prev.threadId,
    prevId: prev.match.id,
    sinceCursor: prev.nextCursor,
    ticketId: TICKET_ID,
    project: PROJECT,
    audience: "tech",
    timeoutMs: 120_000,
  });
}
