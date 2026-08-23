import { basename } from "node:path";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { seedWorktree } from "./fixture-state.ts";
import { NIMBUS_PROJECT_PATH, PRIMARY_PROJECT_PARENT } from "./project-fixtures.ts";
import type { Step } from "./types.ts";

export const ADDITIONAL_DIRECTORY_PATH = `${PRIMARY_PROJECT_PARENT}/shared-notes`;

export interface RemovalFixture {
  worktreePath: string;
  workspaceName: string;
}

export async function seedRemovalFixture(
  ctx: ScenarioContext,
  ticketId: string,
  dirty = false,
): Promise<RemovalFixture> {
  const worktreePath = await seedWorktree(ctx, NIMBUS_PROJECT_PATH, ticketId, "remove");
  const setup = await ctx.execInGateway(["mkdir", "-p", ADDITIONAL_DIRECTORY_PATH], {
    timeoutMs: 15_000,
  });
  if (setup.exitCode !== 0) throw new Error(`additional-directory setup failed: ${setup.stderr}`);
  if (dirty) {
    const dirtySetup = await ctx.execInGateway(["touch", `${worktreePath}/uncommitted.txt`], {
      timeoutMs: 15_000,
    });
    if (dirtySetup.exitCode !== 0) {
      throw new Error(`dirty-worktree setup failed: ${dirtySetup.stderr}`);
    }
  }
  return { worktreePath, workspaceName: basename(worktreePath) };
}

export async function waitForPathConfirmation(
  ctx: ScenarioContext,
  prevStep: Step,
  worktreePath: string,
): Promise<Step> {
  const wait = await ctx.waitForOutbound(
    (message) =>
      message.direction === "outbound" &&
      message.threadId === prevStep.threadId &&
      message.id !== prevStep.match.id &&
      message.text.includes(worktreePath) &&
      message.text.includes(NIMBUS_PROJECT_PATH),
    {
      sinceCursor: prevStep.nextCursor,
      timeoutMs: 180_000,
      failFastUnmatchedOutbounds: false,
      failFastCliMockGraceMs: false,
    },
  );
  await ctx.judgeLLM({
    attachTo: wait.entry,
    message: wait.match.text,
    rubric:
      "The bot is asking for explicit confirmation before deleting a project. It shows both exact " +
      `paths verbatim: linked worktree ${worktreePath} and main worktree ${NIMBUS_PROJECT_PATH}. ` +
      "It has not claimed either path was deleted yet.",
    label: "exact-project-removal-confirmation",
  });
  return {
    match: wait.match,
    entry: wait.entry,
    threadId: prevStep.threadId,
    nextCursor: wait.nextCursor,
  };
}
