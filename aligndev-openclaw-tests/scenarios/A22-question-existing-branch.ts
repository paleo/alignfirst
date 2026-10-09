import { execFileSync } from "node:child_process";
import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { seedWorktree } from "./_lib/fixture-state.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { runReadOnlyQuestion } from "./_lib/question-flow.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

const TICKET_ID = "ABC-0220";
const BRANCH = `${TICKET_ID}/export`;

export default async function questionAboutExistingBranch(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const worktreeDir = await seedWorktree(ctx, NIMBUS_PROJECT_PATH, TICKET_ID, "export");
  const expectedHead = execFileSync("git", ["-C", worktreeDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  await runReadOnlyQuestion(ctx, {
    text: `Sur la branche ${BRANCH} de nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?`,
    worktreeDir,
    expectedBranch: BRANCH,
    expectedHead,
    existingWorktrees: [worktreeDir],
    ticketId: TICKET_ID,
  });
}
