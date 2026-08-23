import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { escapeRe } from "./_lib/common-constants.ts";
import { registeredProject, setupAlprojectMock } from "./_lib/mock-alproject.ts";
import {
  assertAgentCommandOrder,
  assertAlprojectCallOrder,
  pathExists,
  waitForLifecycle,
} from "./_lib/project-lifecycle.ts";
import {
  ADDITIONAL_DIRECTORY_PATH,
  seedRemovalFixture,
  waitForPathConfirmation,
} from "./_lib/project-removal.ts";
import { NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0180";

export default async function projectRemoval(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const fixture = await seedRemovalFixture(ctx, TICKET_ID);
  const alproject = setupAlprojectMock(ctx, {
    projects: [
      {
        ...registeredProject(PROJECT, NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT),
        workspaces: [fixture.workspaceName],
      },
    ],
    additionalDirectories: [
      { parent: PRIMARY_PROJECT_PARENT, directories: [ADDITIONAL_DIRECTORY_PATH] },
    ],
  });

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Supprime physiquement le projet ${PROJECT}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    audience: "tech",
    seededWorktreePaths: [fixture.worktreePath],
  });
  await sendInThread(ctx, starter.threadId, "Prépare la suppression et montre-moi les chemins.");
  await waitForPathConfirmation(ctx, starter, fixture.worktreePath);
  assertRemovalHasNotStarted(alproject.calls, fixture.worktreePath);

  await sendInThread(
    ctx,
    starter.threadId,
    `Je confirme exactement ${fixture.worktreePath} et ${NIMBUS_PROJECT_PATH}. Supprime-les.`,
  );
  await waitForLifecycle(
    () =>
      !pathExists(fixture.worktreePath) &&
      !pathExists(NIMBUS_PROJECT_PATH) &&
      alproject.projects.length === 0 &&
      alproject.calls.some(
        (call) => call.argv[0] === "list" && call.order > (unregisterOrder(alproject.calls) ?? 999),
      ),
    { label: "confirmed project removal" },
  );

  if (!pathExists(ADDITIONAL_DIRECTORY_PATH)) {
    throw new Error(`additional directory was removed: ${ADDITIONAL_DIRECTORY_PATH}`);
  }
  assertAlprojectCallOrder(
    alproject.calls,
    (call) => call.argv[0] === "--guide",
    (call) => call.argv[0] === "unregister" && call.argv[1] === NIMBUS_PROJECT_PATH,
    "guide must precede unregistration",
  );
  assertAlprojectCallOrder(
    alproject.calls,
    (call) => call.argv[0] === "unregister",
    (call) =>
      call.argv.length === 1 &&
      call.argv[0] === "list" &&
      call.order > (unregisterOrder(alproject.calls) ?? Number.POSITIVE_INFINITY),
    "unregistration must precede the final inventory",
  );
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
  assertAgentCommandOrder(
    ctx.getAgentToolCalls(),
    new RegExp(String.raw`workspace\s+remove[^\n]*${escapeRe(fixture.workspaceName)}`),
    new RegExp(String.raw`\brm\b[^\n]*${escapeRe(NIMBUS_PROJECT_PATH)}`),
    "workspace tooling must remove the linked worktree before the main worktree",
  );

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function assertRemovalHasNotStarted(
  calls: ReturnType<typeof setupAlprojectMock>["calls"],
  worktreePath: string,
): void {
  if (!pathExists(worktreePath) || !pathExists(NIMBUS_PROJECT_PATH)) {
    throw new Error("project removal started before path confirmation");
  }
  if (calls.some((call) => call.argv[0] === "unregister")) {
    throw new Error("project was unregistered before path confirmation");
  }
}

function unregisterOrder(
  calls: ReturnType<typeof setupAlprojectMock>["calls"],
): number | undefined {
  return calls.find((call) => call.argv[0] === "unregister")?.order;
}
