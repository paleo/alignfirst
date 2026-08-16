import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError, type CliContext } from "./context.js";
import { gitOutput } from "./git.js";

/**
 * How `.plans` is wired for this project.
 *
 * - `shared` — a symlink into a clone of the team plans repository. `sync` publishes there.
 * - `local` — a plain directory in the product repository, for a contributor without access to
 *   the team clone. `sync` has nowhere to publish.
 */
export type PlansMode = SharedPlans | LocalPlans;

export interface SharedPlans {
  kind: "shared";
  /** Toplevel of the plans repository clone. */
  repoToplevel: string;
}

export interface LocalPlans {
  kind: "local";
}

/**
 * Classifies `.plans`, or throws when it is unusable: missing, broken symlink, not a directory.
 *
 * Shared means `.plans` resolves into a git repository other than this project's own. The
 * comparison runs against the main worktree, never the current one. A linked worktree has its own
 * toplevel, so comparing against it would read a local `.plans` as shared, and `sync` would commit
 * into the product repository.
 */
export function resolvePlansMode(ctx: CliContext): PlansMode {
  const plansPath = join(ctx.cwd, ".plans");
  const stats = lstatSync(plansPath, { throwIfNoEntry: false });
  if (!stats)
    throw new CliError(
      ".plans is missing. Clone the team plans repository, then run the plans:setup script " +
        "(see the project documentation) — or create a plain .plans directory to keep plans local.",
    );
  if (stats.isSymbolicLink() && !existsSync(plansPath))
    throw new CliError(
      "The .plans symlink is broken. Re-run the plans:setup script with the clone location.",
    );
  if (!statSync(plansPath).isDirectory())
    throw new CliError(
      ".plans is not a directory. Remove it, then run the plans:setup script (see the project documentation).",
    );
  const plansToplevel = plansRepoToplevel(plansPath, stats.isSymbolicLink());
  // Inside this project's own repository: a plain local directory, kept on this machine.
  if (realpathSync(plansToplevel) === realpathSync(mainWorktree(ctx))) return { kind: "local" };
  return { kind: "shared", repoToplevel: plansToplevel };
}

/**
 * The plans directory's own git toplevel.
 *
 * A symlink leading outside any git repository stays an error. Local mode is a plain directory,
 * so such a link means the clone moved away, and reading it as local would bury the breakage.
 */
function plansRepoToplevel(plansPath: string, isSymlink: boolean): string {
  try {
    return gitOutput(plansPath, "rev-parse", "--show-toplevel");
  } catch {
    if (isSymlink)
      throw new CliError(
        ".plans points outside any git repository. Re-run the plans:setup script with the clone location.",
      );
    throw new CliError(
      ".plans is not inside a git repository. Run this command from a worktree root.",
    );
  }
}

/**
 * The main worktree's root, from any worktree of the project. `--git-common-dir` is the shared
 * `.git` directory, whose parent is the main worktree. `--show-toplevel` gives the current one.
 */
function mainWorktree(ctx: CliContext): string {
  const commonDir = gitOutput(ctx.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return dirname(resolve(ctx.cwd, commonDir));
}
