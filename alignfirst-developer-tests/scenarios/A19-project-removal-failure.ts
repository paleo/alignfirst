import type { ScenarioContext } from "@paleo/openclaw-test";
import { execMatches } from "./_lib/agent-tool-calls.ts";
import { registeredProject, setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { pathExists } from "./_lib/project-lifecycle.ts";
import {
  ADDITIONAL_DIRECTORY_NAME,
  ADDITIONAL_DIRECTORY_PATH,
  seedRemovalFixture,
  waitForPathConfirmation,
} from "./_lib/project-removal.ts";
import { NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nimbus";
const TICKET_ID = "ABC-0190";

export default async function projectRemovalFailure(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const fixture = await seedRemovalFixture(ctx, TICKET_ID, true);
  const alproject = setupAlprojectMock(ctx, {
    projects: [
      {
        ...registeredProject(PROJECT, NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT),
        workspaces: [fixture.workspaceName],
      },
    ],
    additionalDirectories: [
      { parent: PRIMARY_PROJECT_PARENT, directories: [ADDITIONAL_DIRECTORY_NAME] },
    ],
  });

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Supprime physiquement le projet ${PROJECT}.`,
    project: PROJECT,
    projectPath: NIMBUS_PROJECT_PATH,
    seededWorktreePaths: [fixture.worktreePath],
  });
  await sendInThread(ctx, starter.threadId, "Prépare la suppression et montre-moi les chemins.");
  await waitForPathConfirmation(ctx, starter, fixture.worktreePath);
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

  for (const path of [fixture.worktreePath, NIMBUS_PROJECT_PATH, ADDITIONAL_DIRECTORY_PATH]) {
    if (!pathExists(path)) throw new Error(`failure recovery removed ${path}`);
  }
  if (!alproject.projects.some((project) => project.mainPath === NIMBUS_PROJECT_PATH)) {
    throw new Error("failure recovery changed the registry state");
  }
  if (alproject.calls.some((call) => call.argv[0] === "unregister")) {
    throw new Error(`unregister ran after workspace failure: ${JSON.stringify(alproject.calls)}`);
  }

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}
