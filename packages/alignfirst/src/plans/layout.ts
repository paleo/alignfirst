import { existsSync, lstatSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";

export const PLANS_DIR = ".plans";
export const ARCHIVES_DIR = "_archives";

export function isTicketName(name: string): boolean {
  return !name.startsWith("_");
}

export function plansDir(cwd: string): string {
  return join(cwd, PLANS_DIR);
}

export function archivesDir(cwd: string): string {
  return join(plansDir(cwd), ARCHIVES_DIR);
}

/** Returns the lstat of `.plans`, so callers can tell a symlink from a directory. */
export function assertPlansGate(cwd: string, form: string): Stats {
  const path = plansDir(cwd);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) throw missingPlansError(form);
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

export function missingPlansMessage(form: string): string {
  return `No .plans/ directory in the current directory.\nLocal work files:  mkdir .plans && echo .plans >> .gitignore\nTeam work files:   ${form} plans setup <clone-dir>`;
}

export function missingPlansError(form: string): CliError {
  return new CliError(missingPlansMessage(form));
}
