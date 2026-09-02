import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { CliError, type CliContext } from "./context.js";
import { resolvePlansMode } from "./plans-path.js";

const DEFAULT_ARCHIVE_DAYS = 7;
const DAY_MS = 86_400_000;

export function runAutoArchive(ctx: CliContext, args: string[]): void {
  rejectAutoArchiveArguments(args);
  const mode = resolvePlansMode(ctx);
  const archived = autoArchive(join(ctx.cwd, ".plans"), archiveThresholdDays(), ctx.stdout);
  if (mode.kind === "shared" && archived) ctx.stdout.write(`Publish with: ${ctx.syncCommand}\n`);
}

function rejectAutoArchiveArguments(args: string[]): void {
  const [unexpected] = args;
  if (unexpected !== undefined) throw new CliError(`Unexpected argument: ${unexpected}`);
}

export function runArchive(ctx: CliContext, args: string[]): void {
  const mode = resolvePlansMode(ctx);
  const plansDir = join(ctx.cwd, ".plans");
  const target = resolveArchiveTarget(ctx.cwd, plansDir, args);
  archiveEntry(plansDir, target, ctx.stdout);
  if (mode.kind === "shared") ctx.stdout.write(`Publish with: ${ctx.syncCommand}\n`);
}

export function archiveThresholdDays(): number {
  const value = process.env.PLANS_SHARE_ARCHIVE_DAYS;
  if (value === undefined) return DEFAULT_ARCHIVE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0)
    throw new CliError("PLANS_SHARE_ARCHIVE_DAYS must be a positive number of days.");
  return days;
}

export function autoArchive(
  plansDir: string,
  thresholdDays: number,
  stdout: { write(s: string): void },
): boolean {
  const cutoff = Date.now() - thresholdDays * DAY_MS;
  const candidates = [
    ...staleTicketDirectories(plansDir, cutoff),
    ...staleNoTicketSessionFiles(plansDir, cutoff),
  ];
  if (candidates.length === 0) {
    stdout.write("Nothing to archive.\n");
    return false;
  }
  for (const candidate of candidates) archiveEntry(plansDir, candidate, stdout);
  return true;
}

function staleTicketDirectories(plansDir: string, cutoff: number): string[] {
  return readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => join(plansDir, entry.name))
    .filter((ticketDir) => newestFileMtime(ticketDir) < cutoff);
}

function newestFileMtime(dir: string): number {
  const files = readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) =>
    entry.isFile(),
  );
  if (files.length === 0) return statSync(dir).mtimeMs;
  return Math.max(...files.map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs));
}

function staleNoTicketSessionFiles(plansDir: string, cutoff: number): string[] {
  const sessionDir = join(plansDir, "_alcode");
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(sessionDir, entry.name))
    .filter((path) => statSync(path).mtimeMs < cutoff);
}

function archiveEntry(
  plansDir: string,
  sourcePath: string,
  stdout: { write(s: string): void },
): void {
  const rel = relative(plansDir, sourcePath);
  const archivesDir = join(plansDir, "_archives");
  const targetDir = join(archivesDir, dirname(rel));
  mkdirSync(targetDir, { recursive: true });
  const target = moveToFreeName(sourcePath, targetDir, statSync(sourcePath).isFile());
  stdout.write(`Archived ${rel} → _archives/${relative(archivesDir, target)}\n`);
}

function moveToFreeName(sourcePath: string, targetDir: string, isFile: boolean): string {
  const name = basename(sourcePath);
  const ext = isFile ? extname(name) : "";
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(targetDir, name);
  for (let suffix = 2; existsSync(candidate); ++suffix) {
    candidate = join(targetDir, `${stem}-${suffix}${ext}`);
  }
  renameSync(sourcePath, candidate);
  return candidate;
}

function resolveArchiveTarget(cwd: string, plansDir: string, args: string[]): string {
  const [argument, unexpected] = args;
  if (argument === undefined) throw new CliError("Usage: plans-share archive <ticket-id | path>");
  if (unexpected !== undefined) throw new CliError(`Unexpected argument: ${unexpected}`);
  const target = isPathArgument(argument) ? resolve(cwd, argument) : join(plansDir, argument);
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || realpathSync(dirname(target)) !== realpathSync(plansDir))
    throw new CliError(`${argument} must be an existing directory directly under .plans.`);
  if (basename(target).startsWith("_"))
    throw new CliError(`${argument}: names starting with _ are not tickets.`);
  return target;
}

function isPathArgument(argument: string): boolean {
  return argument.includes("/") || argument.includes("\\");
}
