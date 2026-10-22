import { existsSync, lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { CliError } from "../cli-error.js";
import { gitBuffer, gitOutput, linkedMainWorktree, optionalRepositoryId } from "../git.js";
import { type ItemLocation, resolveProjectLayout } from "../project-layout.js";

export const ARCHIVES_DIR = "_archives";

export function isTicketName(name: string): boolean {
  return !name.startsWith("_");
}

export function archivesDir(plansPath: string): string {
  return join(plansPath, ARCHIVES_DIR);
}

/** Returns the lstat of `.plans`, so callers can tell a symlink from a directory. */
export function assertPlansGate(
  cwd: string,
  location: ItemLocation,
  form: string,
  home: string,
): Stats {
  assertPlansNotProjectTracked(cwd, location, form);
  const stats = assertUsablePlans(location, form);
  assertMainWorktreePlans(cwd, location, form, home);
  return stats;
}

/** Setup uses only this rule, so absent directories and broken untracked links remain repairable. */
export function assertPlansNotProjectTracked(
  cwd: string,
  location: ItemLocation,
  form: string,
): void {
  const identity = optionalRepositoryId(cwd);
  if (identity === undefined || !existsSync(dirname(location.path))) return;
  const logicalPath = join(realpathSync(dirname(location.path)), basename(location.path));
  const logicalTracked = hasProjectTrackedFiles(dirname(logicalPath), logicalPath, identity);
  const target =
    !logicalTracked && existsSync(location.path) ? realpathSync(location.path) : undefined;
  const realTracked = target !== undefined && hasProjectTrackedFiles(target, target, identity);
  if (!logicalTracked && !realTracked) return;
  throw new CliError(
    `Effective .plans contains files tracked by this project's repository: ${location.path}.\n` +
      "Local work files: git rm -r --cached .plans && echo .plans >> .gitignore, then commit the change.\n" +
      `Team work files: ${form} plans setup <clone-dir>\n` +
      `Companion work files: ${form} companion register, then set items[".plans"] to "companion" in the registry.`,
  );
}

function hasProjectTrackedFiles(dir: string, path: string, identity: string): boolean {
  const containingDir = statSync(dir).isDirectory() ? dir : dirname(dir);
  if (optionalRepositoryId(containingDir) !== identity) return false;
  const root = realpathSync(gitOutput(containingDir, "rev-parse", "--show-toplevel"));
  const pathspec = relative(root, path);
  return (
    gitBuffer(root, "--literal-pathspecs", "ls-files", "-z", "--", pathspec === "" ? "." : pathspec)
      .length > 0
  );
}

function assertUsablePlans(location: ItemLocation, form: string): Stats {
  const { path } = location;
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) throw new CliError(missingPlansMessage(location, form));
  if (stats.isSymbolicLink() && !existsSync(path))
    throw new CliError(
      `The .plans symlink is broken. Re-run ${form} plans setup with the clone location.`,
    );
  if (!statSync(path).isDirectory())
    throw new CliError(
      `.plans is not a directory. Remove it, then run ${form} plans setup (see the project documentation).`,
    );
  return stats;
}

function assertMainWorktreePlans(
  cwd: string,
  location: ItemLocation,
  form: string,
  home: string,
): void {
  const mainWorktree = linkedMainWorktree(cwd);
  if (mainWorktree === undefined) return;
  const main = resolveProjectLayout(mainWorktree, home).locations[".plans"];
  assertPlansNotProjectTracked(mainWorktree, main, form);
  assertUsablePlans(main, form);
  const target = realpathSync(location.path);
  const mainTarget = realpathSync(main.path);
  if (target === mainTarget && location.in === main.in) return;
  throw new CliError(
    `Effective .plans differs between this worktree (${target}, ${location.in}) and the main worktree ${mainWorktree} (${mainTarget}, ${main.in}).\n` +
      "Linked worktrees reach .plans through the main worktree.",
  );
}

export function missingPlansMessage(location: ItemLocation, form: string): string {
  const team = `Team work files:   ${form} plans setup <clone-dir>`;
  if (location.in === "companion")
    return `No .plans/ directory at ${location.path} (companion).\nLocal work files:  mkdir -p ${location.path}\n${team}`;
  return `No .plans/ directory in the current directory.\nLocal work files:  mkdir .plans && echo .plans >> .gitignore\n${team}`;
}
