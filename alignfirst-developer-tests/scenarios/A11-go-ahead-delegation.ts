import type { ScenarioContext } from "@paleo/openclaw-test";
import { inputOf } from "./_lib/agent-tool-calls.ts";
import { expectDelegationChain } from "./_lib/delegation-chain.ts";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
  type CodingAgentMockHandle,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { assertNoChannelRootLeak, assertNoSelfThreadMessagePost } from "./_lib/outbound.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";
import type { Step } from "./_lib/types.ts";
import { settleOnWorkspaceReport } from "./_lib/workspace-flow.ts";

// A<S> → ABC-0<S>N (README convention); scenario A11 → ABC-011N, first ticket ABC-0110.
const TICKET_ID = "ABC-0110";
const PROJECT = "nimbus";

/** A hold during takeover, then two sequential coding runs with one final report each. */
export default async function threadSessionDelegation(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel: ${ctx.channel}, conversationId: ${ctx.conversationId}`);
  await resetFixtures(ctx);
  // Stream delay > exec `yieldMs` (10s default) so OpenClaw auto-backgrounds the alcode exec even if
  // the agent does not pass `background: true`, letting the "started" ack precede the completion wake.
  const codingAgent = setupCodingAgentMock(ctx, { streamDelayMs: 12_000 });
  setupGhMock(ctx);

  const startCursor = await ctx.getCursor();
  const starter = await bootstrapThreadFromChannel(ctx, {
    text:
      `Nouvelle fonctionnalité sur ${PROJECT} : passer le bouton d'export en gras. ` +
      `Ticket ${TICKET_ID}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: TICKET_ID,
    afterStarter: async (threadId) => {
      await sendInThread(
        ctx,
        threadId,
        "Prépare le workspace, mais ne lance aucun travail de code sans mon feu vert.",
      );
    },
  });

  await runSetupPhaseWithoutDelegation(ctx, codingAgent, starter);
  await runGoAheadPhase(ctx, starter.threadId, startCursor);
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/**
 * Phase 1 — the user asks for the workspace and withholds the green light. The structural proof is
 * that the coding-agent mock sees no coding-protocol call; worktree-creation calls are fine.
 */
async function runSetupPhaseWithoutDelegation(
  ctx: ScenarioContext,
  codingAgent: CodingAgentMockHandle,
  starter: Step,
): Promise<void> {
  const { dir: worktreeDir } = await waitForAnyWorktreeDir(NIMBUS_PROJECT_PATH, TICKET_ID, {
    timeoutMs: 180_000,
  });
  const branch = assertBranchForTicket(worktreeDir, TICKET_ID);
  await settleOnWorkspaceReport(ctx, starter, worktreeDir, branch);

  const protocolCall = codingAgent.codingAgentCalls.find((call) =>
    isCodingProtocolPrompt(extractCodingPrompt(call)),
  );
  if (protocolCall) {
    throw new Error(
      `coding-protocol coding-agent call despite the hold: ${JSON.stringify(extractCodingPrompt(protocolCall)?.slice(0, 200))}`,
    );
  }
  ctx.log("no coding-protocol coding-agent call before the go-ahead — OK");
}

async function runGoAheadPhase(
  ctx: ScenarioContext,
  threadId: string,
  startCursor: number,
): Promise<void> {
  for (const [index, text] of [
    "Feu vert : lance le travail. Préviens-moi ici quand c'est terminé.",
    "Deuxième étape : ajoute une infobulle « Exporter les données » sur ce bouton. Préviens-moi quand c'est terminé.",
  ].entries()) {
    const notBefore = new Date().toISOString();
    const sinceCursor = await sendInThread(
      ctx,
      threadId,
      `${text} Cette étape se termine après l'implémentation, les tests et la vérification locale : ` +
        "ne lance aucune revue de code et n'ouvre aucune PR.",
    );
    await expectDelegationChain(ctx, {
      threadId,
      ticketId: TICKET_ID,
      sinceCursor,
      notBefore,
      launchIndex: index + 1,
    });
  }
  const calls = await ctx.getAgentToolCalls();
  ctx.assertLength(
    calls.filter(
      (call) =>
        call.sessionKey?.toLowerCase().includes(threadId.toLowerCase()) === true &&
        call.toolName === "thread_handoff" &&
        inputOf(call).action === "start",
    ),
    0,
    "working thread never starts another handoff",
  );
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });
  await assertNoSelfThreadMessagePost(ctx, threadId, startCursor);
}
