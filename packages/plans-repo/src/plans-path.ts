import { statSync } from "node:fs";
import { CliError } from "./context.js";
import { gitOutput } from "./git.js";

export function checkPlansIsDirectory(plansPath: string): void {
  if (!statSync(plansPath).isDirectory())
    throw new CliError(
      ".plans is not a directory. Remove it, then run the plans:setup script (see the project documentation).",
    );
}

export function plansRepoToplevel(plansPath: string): string {
  try {
    return gitOutput(plansPath, "rev-parse", "--show-toplevel");
  } catch {
    throw new CliError(
      ".plans points outside any git repository. Re-run the plans:setup script with the clone location.",
    );
  }
}
