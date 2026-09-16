import type { ScenarioContext } from "@paleo/openclaw-test";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { runReadOnlyQuestion } from "./_lib/question-flow.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";

export default async function projectInvestigationQuestion(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const refreshedHead = await advanceRemoteMain(ctx);
  await runReadOnlyQuestion(ctx, {
    text: "Sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?",
    worktreeDir: NIMBUS_PROJECT_PATH,
    expectedBranch: "main",
    expectedHead: refreshedHead,
    existingWorktrees: [],
  });
}

async function advanceRemoteMain(ctx: ScenarioContext): Promise<string> {
  const origin = await git(ctx, ["-C", NIMBUS_PROJECT_PATH, "remote", "get-url", "origin"]);
  const gitDir = [`--git-dir=${origin}`];
  const parent = await git(ctx, [...gitDir, "rev-parse", "main"]);
  const tree = await git(ctx, [...gitDir, "rev-parse", "main^{tree}"]);
  const commit = await git(ctx, [
    ...gitDir,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@local",
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "Advance remote for question refresh",
  ]);
  await git(ctx, [...gitDir, "update-ref", "refs/heads/main", commit, parent]);
  return commit;
}

async function git(ctx: ScenarioContext, args: string[]): Promise<string> {
  const result = await ctx.execInGateway(["git", ...args]);
  if (result.exitCode !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}
