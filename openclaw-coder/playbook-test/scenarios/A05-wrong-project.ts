import { existsSync, readdirSync } from "node:fs";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { unknownProjectRubric } from "./_lib/common-constants.ts";
import { setupClaudeMock } from "./_lib/mock-claude.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { requireThreadId } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const WRONG_PROJECT = "aurora";

const PROJECTS_DIR = "/home/claw/projects";

export default async function wrongProject(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  const claude = setupClaudeMock(ctx);
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({
    senderId: "ROBIN01",
    senderName: "ROBIN01",
    text: `Sur ${WRONG_PROJECT}, le bouton d'export ne marche plus.`,
  });

  const starterWait = await ctx.waitForOutbound(
    (m) =>
      m.direction === "outbound" &&
      m.conversation.id === ctx.conversationId &&
      m.threadId !== undefined,
    { timeoutMs: 90_000, sinceCursor: startCursor },
  );
  const threadId = requireThreadId(starterWait);
  ctx.log({ attachTo: starterWait.entry, label: `starter received in thread ${threadId}` });

  // The agent may combine starter + unknown-project acknowledgement in one
  // message (in-starter shortcut, see the playbook-test README.md tolerance).
  const starterAcks = await starterAlreadyAcksUnknownProject(ctx, starterWait.match.text);
  let questionEntry = starterWait.entry;
  let questionText = starterWait.match.text;
  let cursorAfterQuestion = starterWait.nextCursor;
  if (!starterAcks) {
    const followupWait = await ctx.waitForOutbound(
      (m) => m.direction === "outbound" && m.threadId === threadId && m.id !== starterWait.match.id,
      { timeoutMs: 60_000, sinceCursor: starterWait.nextCursor },
    );
    ctx.log({ attachTo: followupWait.entry, label: "follow-up received" });
    questionEntry = followupWait.entry;
    questionText = followupWait.match.text;
    cursorAfterQuestion = followupWait.nextCursor;
  } else {
    ctx.log({ attachTo: starterWait.entry, label: "starter already acknowledges unknown project" });
  }
  await ctx.judgeLLM({
    attachTo: questionEntry,
    message: questionText,
    rubric: unknownProjectRubric(WRONG_PROJECT),
    label: "unknown-project-acknowledgement",
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

async function starterAlreadyAcksUnknownProject(
  ctx: ScenarioContext,
  text: string,
): Promise<boolean> {
  const { parsed } = await ctx.judgeLLMJson<{ acksUnknownProject: boolean; reason: string }>({
    message: text,
    prompt:
      "Does the message acknowledge that the named project is not found under `~/projects/` and ask the user to confirm or correct the name? A bare announcement or starter template without that acknowledgement is false.",
    returnType: '{ "acksUnknownProject": boolean, "reason": string }',
    label: "starter-acks-unknown-project",
  });
  return parsed.acksUnknownProject;
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
