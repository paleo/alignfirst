import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { askWhichProjectRubric } from "./_lib/common-constants.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const TICKET_ID = "ABC-040";

const PROJECTS_DIR = "/home/claw/projects";

export default async function ticketWithoutProject(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "QAUSER01",
    senderName: "QAUSER01",
    text: `Ticket ${TICKET_ID}, on doit corriger le bug d'export.`,
  });

  const starterWait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(starterWait);
  ctx.log({
    attachTo: starterWait.entry,
    prefix: `starter received in thread ${threadId}`,
    message: starterWait.match.text,
  });

  // The agent may combine starter + project question in one message (the
  // in-starter shortcut documented in the playbook-test README.md tolerance). If so, judge the
  // starter text directly; otherwise wait for a separate follow-up.
  const starterAsks = await starterAlreadyAsksWhichProject(ctx, starterWait.match.text);
  let questionEntry = starterWait.entry;
  let questionText = starterWait.match.text;
  let cursorAfterQuestion = starterWait.nextCursor;
  if (!starterAsks) {
    const followupWait = await ctx.waitForOutbound(
      (m) => m.direction === "outbound" && m.threadId === threadId && m.id !== starterWait.match.id,
      { timeoutMs: 60_000, sinceCursor: starterWait.nextCursor },
    );
    ctx.log({
      attachTo: followupWait.entry,
      prefix: "follow-up received",
      message: followupWait.match.text,
    });
    questionEntry = followupWait.entry;
    questionText = followupWait.match.text;
    cursorAfterQuestion = followupWait.nextCursor;
  } else {
    ctx.log({
      attachTo: starterWait.entry,
      prefix: "starter already asks for the project",
      message: starterWait.match.text,
    });
  }
  await ctx.judgeLLM({
    attachTo: questionEntry,
    message: questionText,
    rubric: askWhichProjectRubric(TICKET_ID),
    label: "ask-which-project",
  });

  await ctx.expectNoOutbound((m) => m.direction === "outbound" && m.threadId === threadId, {
    withinMs: 5000,
    sinceCursor: cursorAfterQuestion,
  });

  if (claude.claudeCalls.length > 0) {
    throw new Error(
      `expected no claude call; got ${claude.claudeCalls.length}: ${JSON.stringify(
        claude.claudeCalls.map((c) => c.argv[0]?.slice(0, 60)),
      )}`,
    );
  }
  assertNoWorktreeDirs(ctx);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function starterAlreadyAsksWhichProject(
  ctx: ScenarioContext,
  text: string,
): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ asksWhichProject: boolean; reason: string }>({
    message: text,
    prompt: `Does the message ask the user which project the ticket belongs to (project name unknown, agent requests it)? A bare announcement, filler, or starter template without that ask is false. Answer true only when the message clearly puts a "which project?" request to the user.`,
    returnType: '{ "asksWhichProject": boolean, "reason": string }',
    label: "starter-asks-which-project",
  });
  return parsed.asksWhichProject;
}

function assertNoWorktreeDirs(ctx: ScenarioContext): void {
  if (!existsSync(PROJECTS_DIR)) return;
  const matches = readdirSync(PROJECTS_DIR).filter(
    (entry) => entry.startsWith("nimbus-") || entry.startsWith("lumen-"),
  );
  if (matches.length > 0) {
    throw new Error(`unexpected worktree dirs under ${PROJECTS_DIR}: ${matches.join(", ")}`);
  }
  ctx.log("no worktree dirs created — OK");
}
