import { CliError } from "../cli-error.js";
import { gitOutput, optionalRepositoryId } from "../git.js";
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
export function resolvePlansMode(
  cwd: string,
  location: ItemLocation,
  form: string,
  home: string,
): PlansMode {
  const stats = assertPlansGate(cwd, location, form, home);
  const plansRepository = plansRepositoryId(location.path, stats.isSymbolicLink(), form);
  if (plansRepository === undefined || plansRepository === optionalRepositoryId(cwd))
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
  const identity = optionalRepositoryId(plansPath);
  if (identity === undefined && isSymlink)
    throw new CliError(
      `.plans points outside any git repository. Re-run ${form} plans setup with the clone location.`,
    );
  return identity;
}
