import { existsSync } from "node:fs";
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

export function assertPlansGate(cwd: string, form: string): void {
  if (existsSync(plansDir(cwd))) return;
  throw missingPlansError(form);
}

export function missingPlansMessage(form: string): string {
  return `No .plans/ directory in the current directory.\nLocal plans:  mkdir .plans && echo .plans >> .gitignore\nTeam plans:   ${form} plans setup <clone-dir>`;
}

export function missingPlansError(form: string): CliError {
  return new CliError(missingPlansMessage(form));
}
