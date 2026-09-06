import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { CliError } from "../cli-error.js";
import type { Output } from "../context.js";
import { isTicketName } from "./layout.js";

const DEFAULT_ARCHIVE_DAYS = 7;
const DAY_MS = 86_400_000;

export function archiveThresholdDays(env: NodeJS.ProcessEnv): number {
  const value = env.ALIGNFIRST_ARCHIVE_DAYS;
  if (value === undefined) return DEFAULT_ARCHIVE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0)
    throw new CliError("ALIGNFIRST_ARCHIVE_DAYS must be a positive number of days.");
  return days;
}

export function autoArchive(plansDir: string, thresholdDays: number, stdout: Output): boolean {
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
    .filter((entry) => entry.isDirectory() && isTicketName(entry.name))
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

export function archiveEntry(plansDir: string, sourcePath: string, stdout: Output): void {
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
  for (let suffix = 2; existsSync(candidate); ++suffix)
    candidate = join(targetDir, `${stem}-${suffix}${ext}`);
  renameSync(sourcePath, candidate);
  return candidate;
}
