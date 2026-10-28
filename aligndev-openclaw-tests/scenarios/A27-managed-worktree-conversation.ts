import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { execMatches, invokesAligndevCode, listsProjects } from "./_lib/agent-tool-calls.ts";
import { assertNoChannelTools, settleOnWorkspaceBanner } from "./_lib/app-conversation.ts";
import { escapeRegExp } from "./_lib/fixture-state.ts";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
  type CodingAgentMockHandle,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { assertNoWorktreeDirs } from "./_lib/thread-bootstrap.ts";
import { waitForThreadSettlement } from "./_lib/thread-settlement.ts";

export const surfaces: readonly string[] = ["webchat"];

const TICKET_ID = "ABC-0271";
const REQUEST =
  `Nouvelle fonctionnalité : passer le bouton d'export en gras. Ticket ${TICKET_ID}. ` +
  "Prépare le workspace, mais ne lance aucun travail de code pour l'instant.";
const READY_RE = /\b(?:ready|prête?)\b/i;

/**
 * A conversation created on a fresh OpenClaw managed worktree of `nimbus`: the working session takes
 * the project from the worktree, switches it to a new ticket branch without asking, registers it
 * with the project's workspace tooling, and stops at the `[WORKSPACE]` banner.
 */
export default async function managedWorktreeConversation(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  // OpenClaw keeps a worktree name per repository across fixture resets: a reused stack needs a new one.
  const worktreeName = ctx.conversationId.toLowerCase();
  const created = await ctx.webchat.createConversation({
    cwd: NIMBUS_PROJECT_PATH,
    worktree: { name: worktreeName },
  });
  if (created.worktree === undefined) throw new Error("sessions.create returned no worktree");
  const { sessionKey } = created;
  const worktreePath = created.worktree.path;
  ctx.assertEqual(created.worktree.branch, `openclaw/${worktreeName}`, "managed worktree branch");

  await ctx.webchat.send(sessionKey, REQUEST);
  const branch = await waitForTicketBranch(ctx, worktreePath, 240_000);
  const banner = await settleOnWorkspaceBanner(ctx, sessionKey, worktreePath, branch);
  ctx.assertRegex(banner.text, READY_RE, "workspace banner: status ready");
  await waitForThreadSettlement(ctx, sessionKey);

  await assertWorkspaceRegistered(ctx, worktreePath);
  await assertNoDelegation(ctx, codingAgent);
  await ctx.waitForAgentToolCall((call) => call.sessionKey === sessionKey && listsProjects(call), {
    label: "the conversation reads the project inventory",
  });
  assertNoWorktreeDirs(ctx);
  await assertNoChannelTools(ctx);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/** Poll the managed worktree's branch, in the gateway, until it carries the ticket. */
async function waitForTicketBranch(
  ctx: ScenarioContext,
  worktreePath: string,
  timeoutMs: number,
): Promise<string> {
  const ticketBranchRe = new RegExp(`^${escapeRegExp(TICKET_ID)}/.+`);
  const deadline = Date.now() + timeoutMs;
  let branch: string | undefined;
  while (Date.now() < deadline) {
    const result = await ctx.execInGateway(["git", "-C", worktreePath, "branch", "--show-current"]);
    branch = result.stdout.trim();
    if (ticketBranchRe.test(branch)) {
      ctx.assertRegex(branch, ticketBranchRe, "managed worktree switched to the ticket branch");
      return branch;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`managed worktree is on "${branch}", expected ${TICKET_ID}/<desc>`);
}

/** Inventory proves adoption without depending on text-table formatting or checkout naming. */
async function assertWorkspaceRegistered(
  ctx: ScenarioContext,
  worktreePath: string,
): Promise<void> {
  const result = await ctx.execInGateway(["alignfirst", "workspace", "list", "--json"], {
    cwd: NIMBUS_PROJECT_PATH,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`alignfirst workspace list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  const row = JSON.parse(result.stdout).workspaces.find(
    (entry: { path: string }) => entry.path === worktreePath,
  );
  if (row === undefined) {
    throw new Error(`workspace list does not show ${worktreePath}:\n${result.stdout}`);
  }
  ctx.assertEqual(row.preparation, "ready", "managed worktree is prepared");
  ctx.assertEqual(row.recipe, "manifest", "managed worktree uses its selected recipe");
}

/** The request withholds coding: no protocol run, neither launched nor received by the mock. */
async function assertNoDelegation(
  ctx: ScenarioContext,
  codingAgent: CodingAgentMockHandle,
): Promise<void> {
  const launches = (await ctx.getAgentToolCalls()).filter(
    (call) => invokesAligndevCode(call) && execMatches(call, /--protocol/),
  );
  ctx.assertLength(launches, 0, "no `aligndev code` protocol launch");
  const protocolCalls = codingAgent.codingAgentCalls.filter((call) =>
    isCodingProtocolPrompt(extractCodingPrompt(call)),
  );
  ctx.assertLength(protocolCalls, 0, "the coding agent receives no protocol prompt");
}
