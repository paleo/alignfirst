import { existsSync, lstatSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import type { ItemLocation } from "../project-layout.js";

export const ARCHIVES_DIR = "_archives";

export function isTicketName(name: string): boolean {
  return !name.startsWith("_");
}

export function archivesDir(plansPath: string): string {
  return join(plansPath, ARCHIVES_DIR);
}

/** Returns the lstat of `.plans`, so callers can tell a symlink from a directory. */
export function assertPlansGate(location: ItemLocation, form: string): Stats {
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

export function missingPlansMessage(location: ItemLocation, form: string): string {
  const team = `Team work files:   ${form} plans setup <clone-dir>`;
  if (location.in === "companion")
    return `No .plans/ directory at ${location.path} (companion).\nLocal work files:  mkdir -p ${location.path}\n${team}`;
  return `No .plans/ directory in the current directory.\nLocal work files:  mkdir .plans && echo .plans >> .gitignore\n${team}`;
}
