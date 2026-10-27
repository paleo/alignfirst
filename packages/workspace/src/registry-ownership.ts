import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";

export function assertRegistryOwnership(
  mainWorktree: string,
  currentWorktree: string,
  registryDir: string,
): void {
  const mainRegistry = resolve(mainWorktree, registryDir);
  for (const file of ["workspaces.json", "dev-servers.json", "workspaces.lock"]) {
    assertLocalRegistryPath(mainWorktree, join(mainRegistry, file));
  }
  if (resolve(mainWorktree) === resolve(currentWorktree)) return;
  const currentRegistry = resolve(currentWorktree, registryDir);
  assertLocalPath(currentWorktree, dirname(currentRegistry), true);
  const entry = lstatSync(currentRegistry, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    try {
      if (realpathSync(currentRegistry) === realpathSync(mainRegistry)) return;
    } catch {
      /* Broken links cannot establish registry ownership. */
    }
  }
  throw new WorkspaceError(
    `Linked registry must link to its own main worktree registry: ${currentRegistry}. ` +
      "Existing state was preserved; repair the registry link before retrying.",
  );
}

export function assertLocalRegistryPath(mainWorktree: string, path: string): void {
  assertLocalPath(mainWorktree, path, false);
}

function assertLocalPath(mainWorktree: string, path: string, directory: boolean): void {
  const root = resolve(mainWorktree);
  const child = relative(root, resolve(path));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new WorkspaceError(`Registry path must remain local to the main worktree: ${path}.`);
  }
  let current = root;
  const parts = child.split(sep);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) return;
    const valid = directory || index < parts.length - 1 ? entry.isDirectory() : entry.isFile();
    if (entry.isSymbolicLink() || !valid) {
      throw new WorkspaceError(
        `Registry ownership requires local directories and regular files: ${current}. ` +
          "Preserve existing state and repair the main worktree registry destination before retrying.",
      );
    }
  }
}
