import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, inputOf } from "./_lib/agent-tool-calls.ts";
import {
  assertAgentCommandOrder,
  assertGatewayCommand,
  pathExists,
  readProjectConfig,
  waitForLifecycle,
} from "./_lib/project-lifecycle.ts";
import {
  ADDITIONAL_DIRECTORY_PATH,
  seedRemovalFixture,
  waitForPathConfirmation,
} from "./_lib/project-removal.ts";
import { escapeRe } from "./_lib/common-constants.ts";
import { waitForThreadSettlement } from "./_lib/thread-settlement.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0190";

export default async function projectRemovalFailure(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const fixture = await seedRemovalFixture(ctx, TICKET_ID, true);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Supprime physiquement le projet ${PROJECT}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
  });
  await sendInThread(ctx, starter.threadId, "Prépare la suppression et montre-moi les chemins.");
  await waitForPathConfirmation(ctx, starter, fixture.worktreePath);
  for (const path of [fixture.worktreePath, NIMBUS_PROJECT_PATH]) {
    if (!pathExists(path)) throw new Error(`removal started before path confirmation: ${path}`);
  }
  const cursor = await sendInThread(
    ctx,
    starter.threadId,
    `Je confirme exactement ${fixture.worktreePath} et ${NIMBUS_PROJECT_PATH}. Supprime-les.`,
  );

  await ctx.waitForAgentToolCall(
    (call) => execMatches(call, /workspace\s+remove/) && execMatches(call, /ABC-0190-remove/),
    { label: "workspace removal attempted through project tooling", timeoutMs: 180_000 },
  );
  await ctx.waitForOutbound(
    (message) => message.direction === "outbound" && message.threadId === starter.threadId,
    {
      sinceCursor: cursor,
      timeoutMs: 120_000,
      failFastUnmatchedOutbounds: false,
      failFastCliMockGraceMs: false,
    },
  );

  const claim = await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      call.sessionKey?.toLowerCase().includes(starter.threadId.toLowerCase()) === true,
    { label: "removal belongs to the thread session", timeoutMs: 120_000 },
  );
  if (claim.sessionKey === undefined) throw new Error("Missing thread session attribution");
  await waitForThreadSettlement(ctx, claim.sessionKey);
  for (const path of [fixture.worktreePath, NIMBUS_PROJECT_PATH, ADDITIONAL_DIRECTORY_PATH]) {
    if (!pathExists(path)) throw new Error(`failure recovery removed ${path}`);
  }
  if (readProjectConfig(NIMBUS_PROJECT_PATH) === undefined)
    throw new Error("failure recovery removed the project config");

  await assertGatewayCommand(
    ctx,
    ["rm", `${fixture.worktreePath}/uncommitted.txt`],
    "fixture resolves the dirty-worktree obstruction",
  );
  const retryStartedAt = new Date().toISOString();
  await sendInThread(
    ctx,
    starter.threadId,
    `Le fichier non suivi a été supprimé. Je confirme à nouveau exactement ${fixture.worktreePath} ` +
      `et ${NIMBUS_PROJECT_PATH}. Réessaie la suppression.`,
  );
  await waitForLifecycle(
    () => !pathExists(fixture.worktreePath) && !pathExists(NIMBUS_PROJECT_PATH),
    { label: "confirmed retry removes linked and main worktrees" },
  );
  await waitForThreadSettlement(ctx, claim.sessionKey);
  if (!pathExists(ADDITIONAL_DIRECTORY_PATH)) {
    throw new Error(`additional directory was removed: ${ADDITIONAL_DIRECTORY_PATH}`);
  }
  const calls = await ctx.getAgentToolCalls();
  assertAgentCommandOrder(
    calls,
    /alproject\s+--guide\b/,
    /\brm\s+-rf?\s+\S*nimbus|workspace\s+remove/,
    "guide precedes removal",
  );
  assertAgentCommandOrder(
    calls.filter((call) => call.startedAt !== undefined && call.startedAt >= retryStartedAt),
    new RegExp(String.raw`workspace\s+remove[^\n]*${escapeRe(fixture.workspaceName)}`),
    new RegExp(String.raw`\brm\b[^\n]*${escapeRe(NIMBUS_PROJECT_PATH)}`),
    "retry removes the linked workspace before the main worktree",
  );
  assertAgentCommandOrder(
    calls.filter((call) => call.startedAt !== undefined && call.startedAt >= retryStartedAt),
    new RegExp(String.raw`\brm\b[^\n]*${escapeRe(NIMBUS_PROJECT_PATH)}`),
    /\balproject\s+list\b(?![\s\S]*\balproject\s+list\b)/u,
    "final project inventory follows main-worktree removal",
  );
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
