import type { CliContext } from "./context.js";
import { resolvePlansMode } from "./plans-path.js";

/**
 * Verifies that `.plans` is usable and reports its mode. Both modes exit 0, since a plain local
 * directory is a supported setup. A missing, broken or non-directory `.plans` fails.
 */
export function runCheck(ctx: CliContext): void {
  const mode = resolvePlansMode(ctx);
  if (mode.kind === "shared") {
    ctx.stdout.write(".plans is linked to the team plans repository.\n");
    return;
  }
  ctx.stdout.write(
    ".plans is a local directory (local plans mode): synchronization is disabled.\n",
  );
}
