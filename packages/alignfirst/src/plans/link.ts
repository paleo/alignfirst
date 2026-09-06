import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";

export function linkPlans(ctx: CommandContext, targetDir: string): void {
  const plansPath = join(ctx.cwd, ".plans");
  const stats = lstatSync(plansPath, { throwIfNoEntry: false });
  if (stats?.isSymbolicLink()) {
    if (existsSync(plansPath) && realpathSync(plansPath) === realpathSync(targetDir)) {
      ctx.stdout.write(".plans already links to the plans repository.\n");
      return;
    }
    rmSync(plansPath);
  } else if (stats?.isDirectory()) {
    migratePlansContent(ctx, plansPath, targetDir);
  } else if (stats) {
    throw new CliError(".plans exists and is not a directory.");
  }
  const target = relative(ctx.cwd, targetDir);
  symlinkSync(target, plansPath);
  ctx.stdout.write(`Linked .plans → ${target}\n`);
  ctx.stdout.write(`Publish with: ${ctx.form} sync\n`);
}

function migratePlansContent(ctx: CommandContext, plansPath: string, targetDir: string): void {
  const entries = readdirSync(plansPath);
  const collisions = entries.filter((entry) => existsSync(join(targetDir, entry)));
  if (collisions.length > 0)
    throw new CliError(
      `Cannot migrate .plans: already in ${targetDir}: ${collisions.join(", ")}. ` +
        "Merge them manually, then re-run.",
    );
  for (const entry of entries)
    cpSync(join(plansPath, entry), join(targetDir, entry), { recursive: true });
  rmSync(plansPath, { recursive: true });
  if (entries.length > 0)
    ctx.stdout.write(`Migrated ${entries.length} entries from the local .plans directory.\n`);
}
