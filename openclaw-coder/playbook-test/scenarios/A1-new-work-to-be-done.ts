import type { ScenarioContext } from "@paleo/openclaw-test";
import {
  NEW_WORK_QUESTION_RUBRIC,
  STARTER_ANNOUNCEMENT_RUBRIC,
  starterLineRegexNoTicket,
} from "./_lib/common-constants.ts";
import { waitForOutboundSkippingNarration } from "./_lib/meta-narration.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
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

  ctx.log({ attachTo: ack.entry, prefix: "ack received", message: ack.match.text });
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function sendInitialRequestAndExpectStarter(ctx: ScenarioContext): Promise<StarterStep> {
  const startCursor = await ctx.getCursor();

  await ctx.sendInbound({
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: "Nous avons un travail à faire sur nimbus.",
  });

  // Starter wait is strict: the first thread message must be the templated
  // starter — no meta-narration tolerated here.
  const wait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const starter = wait.match;
  const threadId = requireThreadId(wait);
  ctx.log({
    attachTo: wait.entry,
    prefix: `starter received in thread ${threadId}`,
    message: starter.text,
  });

  const lines = starter.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const templateRe = starterLineRegexNoTicket(PROJECT);
  const templateIdx = lines.findIndex((l) => templateRe.test(l));
  if (templateIdx === -1) {
    throw new Error(
      `starter does not contain template line matching ${templateRe}; got: ${JSON.stringify(lines)}`,
    );
  }
  const rest = lines
    .filter((_, i) => i !== templateIdx)
    .join("\n")
    .trim();
  ctx.assertRegex(rest, /\S/, "starter has content beyond the template line");

  const questionAlreadyAsked = await classifyStarterRest(ctx, wait.entry, rest);

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
      "Does the message ask the user about the new work? That includes requesting the ticket id, the change scope/description, the change type (feat/fix/refactor/chore), or any combination. Answer true only when the message clearly puts a request to the user about that. A bare announcement or filler phrase is not a request.",
    returnType: `{ "asksAboutTheWork": boolean, "reason": string }`,
    label: "starter-asks-about-work",
  });

  const asksAboutTheWork = classification.parsed.asksAboutTheWork;
  ctx.log({
    attachTo: entry,
    prefix: "starter-rest classified",
    message: `asksAboutTheWork=${asksAboutTheWork}: ${classification.parsed.reason}`,
  });

  if (asksAboutTheWork) {
    await ctx.judgeLLM({
      attachTo: entry,
      message: rest,
      rubric: NEW_WORK_QUESTION_RUBRIC,
      label: "starter-work-question",
    });
  } else {
    await ctx.judgeLLM({
      attachTo: entry,
      message: rest,
      rubric: STARTER_ANNOUNCEMENT_RUBRIC,
      label: "starter-announcement",
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
  ctx.log({ attachTo: wait.entry, prefix: "follow-up received", message: wait.match.text });

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
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: `Ticket ${TICKET_ID}. La fonctionnalité dont nous avons besoin : passer le bouton d'export en gras.`,
    threadId: prev.threadId,
  });

  return await waitForSetupAck(ctx, {
    threadId: prev.threadId,
    prevId: prev.match.id,
    sinceCursor: prev.nextCursor,
    ticketId: TICKET_ID,
    project: PROJECT,
  });
}
