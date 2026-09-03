import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches, listsProjects, nthMatchingCall } from "./_lib/agent-tool-calls.ts";
import { escapeRe } from "./_lib/common-constants.ts";
import { assertAgentCommandOrder, pathExists, waitForLifecycle } from "./_lib/project-lifecycle.ts";
import {
  ADDITIONAL_DIRECTORY_PATH,
  seedRemovalFixture,
  waitForPathConfirmation,
} from "./_lib/project-removal.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0180";

export default async function projectRemoval(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const fixture = await seedRemovalFixture(ctx, TICKET_ID);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Supprime physiquement le projet ${PROJECT}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    seededWorktreePaths: [fixture.worktreePath],
  });
  await sendInThread(ctx, starter.threadId, "Prépare la suppression et montre-moi les chemins.");
  await waitForPathConfirmation(ctx, starter, fixture.worktreePath);
  assertRemovalHasNotStarted(fixture.worktreePath);

  await sendInThread(
    ctx,
    starter.threadId,
    `Je confirme exactement ${fixture.worktreePath} et ${NIMBUS_PROJECT_PATH}. Supprime-les.`,
  );
  await waitForLifecycle(
    () => !pathExists(fixture.worktreePath) && !pathExists(NIMBUS_PROJECT_PATH),
    { label: "confirmed project removal" },
  );
  await ctx.waitForAgentToolCall(nthMatchingCall(listsProjects, 3), {
    label: "final project listing after removal",
    timeoutMs: 60_000,
  });

  if (!pathExists(ADDITIONAL_DIRECTORY_PATH)) {
    throw new Error(`additional directory was removed: ${ADDITIONAL_DIRECTORY_PATH}`);
  }
  // waitForLifecycle proved the removal on the filesystem, but the trajectory
  // flushes seconds after the turn — ride it out on the later of the two
  // ordered commands before the one-shot ordering parse.
  await ctx.waitForAgentToolCall(
    (call) =>
      execMatches(call, /\brm\b/) && execMatches(call, new RegExp(escapeRe(NIMBUS_PROJECT_PATH))),
    { label: "main-worktree removal visible in the trajectory", timeoutMs: 60_000 },
  );
  // The workspace name matches both path forms the bot uses (absolute, or
  // `../<name>` relative to the main worktree).
  const calls = await ctx.getAgentToolCalls();
  assertAgentCommandOrder(
    calls,
    /alcode\s+projects\s+--guide\b/,
    /\brm\s+-rf?\s+\S*nimbus|workspace\s+remove/,
    "guide must precede removal",
  );
  assertAgentCommandOrder(
    calls,
    new RegExp(String.raw`workspace\s+remove[^\n]*${escapeRe(fixture.workspaceName)}`),
    new RegExp(String.raw`\brm\b[^\n]*${escapeRe(NIMBUS_PROJECT_PATH)}`),
    "workspace tooling must remove the linked worktree before the main worktree",
  );

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function assertRemovalHasNotStarted(worktreePath: string): void {
  if (!pathExists(worktreePath) || !pathExists(NIMBUS_PROJECT_PATH)) {
    throw new Error("project removal started before path confirmation");
  }
}
