import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import { gitOutput } from "../git.js";
import { missingPlansError } from "./layout.js";

export type PlansMode = SharedPlans | LocalPlans;

export interface SharedPlans {
  kind: "shared";
  repoToplevel: string;
}

export interface LocalPlans {
  kind: "local";
}

export function resolvePlansMode(cwd: string, form: string): PlansMode {
  const plansPath = join(cwd, ".plans");
  const stats = lstatSync(plansPath, { throwIfNoEntry: false });
  if (!stats) throw missingPlansError(form);
  if (stats.isSymbolicLink() && !existsSync(plansPath))
    throw new CliError(
      `The .plans symlink is broken. Re-run ${form} plans setup with the clone location.`,
    );
  if (!statSync(plansPath).isDirectory())
    throw new CliError(
      `.plans is not a directory. Remove it, then run ${form} plans setup (see the project documentation).`,
    );
  if (plansRepositoryId(plansPath, stats.isSymbolicLink(), form) === repositoryId(cwd))
    return { kind: "local" };
  return { kind: "shared", repoToplevel: gitOutput(plansPath, "rev-parse", "--show-toplevel") };
}

function plansRepositoryId(plansPath: string, isSymlink: boolean, form: string): string {
  try {
    return repositoryId(plansPath);
  } catch {
    if (isSymlink)
      throw new CliError(
        `.plans points outside any git repository. Re-run ${form} plans setup with the clone location.`,
      );
    throw new CliError(
      ".plans is not inside a git repository. Run this command from a worktree root.",
    );
  }
}

function repositoryId(dir: string): string {
  return realpathSync(gitOutput(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}
