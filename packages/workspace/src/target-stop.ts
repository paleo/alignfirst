import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { executeCommand } from "./command-executor.js";
import { type DevServerEntry, markDevServerCleanupPending } from "./dev-servers-registry.js";
import { WorkspaceError } from "./errors.js";
import { installedCliCommand } from "./invocation.js";
import type { WorkspaceOperation } from "./operation.js";
import {
  assertWorkspaceRecipe,
  findWorkspaceByPath,
  readWorkspaces,
  type WorkspaceRecipe,
} from "./workspaces.js";

export interface TargetStopInput {
  operation: WorkspaceOperation;
  mainWorktree: string;
  registryDir: string;
  target: DevServerEntry;
  signal?: AbortSignal;
  retainCleanup?: boolean;
  local?: { worktree: string; recipe: WorkspaceRecipe; stop: () => Promise<void> };
}

/** Only the child-local down path executes a loaded recipe; multi-target callers dispatch here. */
export async function stopTarget(input: TargetStopInput): Promise<void> {
  const { operation, mainWorktree, registryDir, target } = input;
  input.signal?.throwIfAborted();
  await markDevServerCleanupPending(mainWorktree, registryDir, target.worktree);
  if (!existsSync(target.worktree))
    throw new WorkspaceError(
      `Cannot load stop recipe for missing worktree ${target.worktree}. Run alignfirst workspace teardown or prune from the main worktree.`,
    );
  const registered = findWorkspaceByPath(
    readWorkspaces(mainWorktree, registryDir),
    target.worktree,
  );
  const isLocal =
    input.local !== undefined && resolve(input.local.worktree) === resolve(target.worktree);
  if (registered) {
    const selected = isLocal
      ? input.local?.recipe
      : operation.host?.loadWorkspace?.(target.worktree).recipe;
    assertWorkspaceRecipe(
      target.worktree,
      registered.entry.recipe,
      selected ?? { kind: "defaults" },
    );
  }
  if (input.local && isLocal) {
    await input.local.stop();
    return;
  }
  const child = installedCliCommand(operation.invocation, [
    "dev",
    "down",
    ...(input.retainCleanup === true ? ["--retain-cleanup"] : []),
  ]);
  await executeCommand(
    { command: child.executable, args: child.args, cwd: target.worktree, env: operation.env },
    {
      label: `dev down (${target.name})`,
      signal: input.signal,
      cooperativeCancellation: true,
      stdout: "stream",
      output: operation.output,
    },
  );
}
