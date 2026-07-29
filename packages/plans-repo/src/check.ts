import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { CliError, type CliContext } from "./context.js";
import { gitOutput } from "./git.js";
import { checkPlansIsDirectory, plansRepoToplevel } from "./plans-path.js";

export function runCheck(ctx: CliContext): void {
  const plansPath = join(ctx.cwd, ".plans");
  const stats = lstatSync(plansPath, { throwIfNoEntry: false });
  if (!stats)
    throw new CliError(
      ".plans is missing. Clone the team plans repository, then run the plans:setup script (see the project documentation).",
    );
  if (stats.isSymbolicLink() && !existsSync(plansPath))
    throw new CliError(
      "The .plans symlink is broken. Re-run the plans:setup script with the clone location.",
    );
  checkPlansIsDirectory(plansPath);
  const plansToplevel = plansRepoToplevel(plansPath);
  const repoToplevel = gitOutput(ctx.cwd, "rev-parse", "--show-toplevel");
  if (plansToplevel === repoToplevel)
    throw new CliError(
      ".plans is not linked to the team plans repository. Run the plans:setup script first (see the project documentation).",
    );
  ctx.stdout.write(".plans is linked to the team plans repository.\n");
}
