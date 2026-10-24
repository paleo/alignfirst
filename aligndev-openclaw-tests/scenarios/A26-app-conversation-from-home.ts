import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { execMatches, invokesAligndevCode, listsProjects } from "./_lib/agent-tool-calls.ts";
import {
  assertNoChannelTools,
  expectAppDelegationChain,
  settleOnWorkspaceBanner,
  waitForJudgedReply,
} from "./_lib/app-conversation.ts";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { assertNoWorktreeDirs } from "./_lib/thread-bootstrap.ts";
import { waitForThreadSettlement } from "./_lib/thread-settlement.ts";

export const surfaces: readonly string[] = ["webchat"];

const TICKET_ID = "ABC-0260";
const PROJECT = "nimbus";
const REQUEST =
  `Nouvelle fonctionnalité sur ${PROJECT} : passer le bouton d'export en gras. Ticket ${TICKET_ID}. ` +
  "Cette étape se termine après l'implémentation, les tests et la vérification locale : " +
  "ne lance aucune revue de code et n'ouvre aucune PR.";

const HOME_REDIRECT_RUBRIC =
  "This is the single reply an assistant posted in its app's default conversation (Home) to a " +
  `change request on the project ${PROJECT}. PASS if it asks the user to open a new conversation ` +
  "for this request (on the agent workspace or on the project's folder) and names the project " +
  `${PROJECT}. A question or an offer about that new conversation is fine. FAIL if it claims that a ` +
  "workspace or a branch was set up, or that a coding run started or finished.";

const WORKSPACE_SETUP_RE = /\bworkspace\s+setup\b|\bworktree\s+(?:add|setup)\b/;

/**
 * Home redirects an actionable request to a new conversation and does no project work. The new
 * conversation, on the agent workspace, resolves the project, sets up the ticket's workspace and
 * delegates in the background; the completion report lands in the same conversation.
 */
export default async function appConversationFromHome(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  setupCodingAgentMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  await expectHomeRedirect(ctx);
  await runNewConversation(ctx);

  await assertNoChannelTools(ctx);
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function expectHomeRedirect(ctx: ScenarioContext): Promise<void> {
  const { homeKey } = ctx.webchat;
  await ctx.webchat.send(homeKey, REQUEST);
  await waitForJudgedReply(ctx, homeKey, {
    rubric: HOME_REDIRECT_RUBRIC,
    label: "home-redirect",
    timeoutMs: 180_000,
  });
  await waitForThreadSettlement(ctx, homeKey);

  const homeCalls = (await ctx.getAgentToolCalls()).filter((call) => call.sessionKey === homeKey);
  ctx.assertLength(
    homeCalls.filter(invokesAligndevCode),
    0,
    "Home launches no `aligndev code` run",
  );
  ctx.assertLength(
    homeCalls.filter((call) => execMatches(call, WORKSPACE_SETUP_RE)),
    0,
    "Home runs no workspace setup",
  );
  assertNoWorktreeDirs(ctx);
}

async function runNewConversation(ctx: ScenarioContext): Promise<void> {
  const { sessionKey } = await ctx.webchat.createConversation();
  const notBefore = new Date().toISOString();
  await ctx.webchat.send(sessionKey, REQUEST);

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 240_000,
  });
  const branch = assertBranchForTicket(worktreeDir, TICKET_ID);
  const banner = await settleOnWorkspaceBanner(ctx, sessionKey, worktreeDir, branch);
  await ctx.waitForAgentToolCall((call) => call.sessionKey === sessionKey && listsProjects(call), {
    label: "the conversation resolves the project from the inventory",
  });
  await expectAppDelegationChain(ctx, {
    sessionKey,
    ticketId: TICKET_ID,
    notBefore,
    launchIndex: 1,
    consumed: [banner],
  });
}
