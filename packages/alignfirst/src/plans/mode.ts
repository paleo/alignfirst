import { realpathSync } from "node:fs";

import { CliError } from "../cli-error.js";
import { gitOutput } from "../git.js";
import type { ItemLocation } from "../project-layout.js";
import { assertPlansGate } from "./layout.js";

export type PlansMode = SharedPlans | LocalPlans;

export interface SharedPlans {
  kind: "shared";
  repoToplevel: string;
}

export interface LocalPlans {
  kind: "local";
}

/** `.plans` is shared when it sits in another repository than the project's. */
export function resolvePlansMode(cwd: string, location: ItemLocation, form: string): PlansMode {
  const stats = assertPlansGate(location, form);
  const plansRepository = plansRepositoryId(location.path, stats.isSymbolicLink(), form);
  if (plansRepository === undefined || plansRepository === repositoryId(cwd))
    return { kind: "local" };
  return {
    kind: "shared",
    repoToplevel: gitOutput(location.path, "rev-parse", "--show-toplevel"),
  };
}

/** Returns `undefined` for a real directory outside any git repository. */
function plansRepositoryId(
  plansPath: string,
  isSymlink: boolean,
  form: string,
): string | undefined {
  try {
    return repositoryId(plansPath);
  } catch {
    if (isSymlink)
      throw new CliError(
        `.plans points outside any git repository. Re-run ${form} plans setup with the clone location.`,
      );
    return;
  }
}

function repositoryId(dir: string): string {
  return realpathSync(gitOutput(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}
