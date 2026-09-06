import { mkdir, writeFile } from "node:fs/promises";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { waitForCodingSessionSucceeded } from "./_lib/coding-session.ts";
import { assertBranchForTicket, seedBranch, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import {
  expectCodingDelegation,
  extractCodingPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock, type GhCall } from "./_lib/mock-gh.ts";
import { waitForReport } from "./_lib/outbound.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const PULL_REQUEST_URL = "https://github.com/acme/nimbus/pull/42";
const TICKET_ID = "ABC-0230";
const SOURCE_BRANCH = `${TICKET_ID}/review-export`;
const REVIEW_RESULT =
  "Review complete against main. No findings: the change is focused, covered, and safe to merge. " +
  "Review file: .plans/ABC-0230/A1-review.md.";

export default async function resourceUrlHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx);
  await seedBranch(ctx, NIMBUS_PROJECT_PATH, TICKET_ID, "review-export");
  const codingAgent = setupCodingAgentMock(ctx, {
    streamDelayMs: 12_000,
    onPrompt: async (_scenario, cwd, prompt) => {
      if (!/^Run the _review_ protocol/iu.test(prompt)) return;
      await writeReviewFile(cwd);
      return REVIEW_RESULT;
    },
  });
  const gh = setupGhMock(ctx, {
    url: PULL_REQUEST_URL,
    number: 42,
    title: `[${TICKET_ID}] Review export behavior`,
    headRefName: SOURCE_BRANCH,
    baseRefName: "main",
  });

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Peux-tu relire ${PULL_REQUEST_URL} ?`,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    codingAgent,
  });

  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      `A thread-opening handoff for reviewing ${PULL_REQUEST_URL}. It retains the URL and brings ` +
      "the user back — an explicit ask for a reply, or a statement that the user's next message " +
      "launches the working session. It may promise that the working session will derive the " +
      "ticket from the URL, but does not ask the user for a ticket ID or claim that the pull " +
      "request has already been read.",
    label: "resource-url-deferred-to-working-session",
  });
  alproject.assertListCallCount(1);

  const goAheadCursor = starter.nextCursor;
  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 180_000,
  });
  assertBranchForTicket(worktreeDir, TICKET_ID);

  const reviewCall = await expectCodingDelegation(ctx, codingAgent, {
    ticketId: TICKET_ID,
    matches: (call) => /^Run the _review_ protocol/iu.test(extractCodingPrompt(call) ?? ""),
    rubric:
      "Grade only the captured alcode delegation text. Pass if it invokes the AlignFirst review " +
      `protocol for ticket ${TICKET_ID}. Reject only if the ticket is wrong or it invokes a change, ` +
      "implementation, or non-review protocol. Do not require GitHub or workspace evidence here; " +
      "the scenario verifies those separately with deterministic assertions.",
    label: "pull-request-review-delegation",
  });
  if (reviewCall.cwd !== worktreeDir) {
    throw new Error(`review ran from ${reviewCall.cwd}, expected linked worktree ${worktreeDir}`);
  }
  if (!gh.calls.some(resolvesPullRequest)) {
    throw new Error(`working session never resolved the pull request: ${JSON.stringify(gh.calls)}`);
  }

  await waitForCodingSessionSucceeded(ctx, { ticketId: TICKET_ID, timeoutMs: 120_000 });
  const report = await waitForReport(
    ctx,
    (message) =>
      message.direction === "outbound" &&
      message.threadId === starter.threadId &&
      /(?:no findings|aucun[^.\n]*(?:problème|commentaire|retour|remarque)|0 commentaire)/iu.test(
        message.text,
      ),
    { sinceCursor: goAheadCursor, timeoutMs: 240_000 },
  );
  await ctx.judgeLLM({
    attachTo: report.entry,
    message: report.match.text,
    rubric:
      "A final pull-request review outcome. It says the review completed and reports no findings " +
      "or no review concerns. It may say that a no-findings summary was posted to the pull request. " +
      "Reject setup, launch, or still-in-progress messages.",
    label: "pull-request-review-outcome",
  });

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function resolvesPullRequest(call: GhCall): boolean {
  if (call.argv[0] === "pr" && call.argv[1] === "view") return true;
  return call.argv[0] === "api" && call.argv.some((arg) => /\/pulls\/42$/u.test(arg));
}

async function writeReviewFile(worktreeDir: string): Promise<void> {
  const taskDir = `${worktreeDir}/.plans/${TICKET_ID}`;
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    `${taskDir}/A1-review.md`,
    "# Code Review\n\nNo findings. The pull request is safe to merge.\n",
    "utf8",
  );
}
