import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { CliError } from "../cli-error.js";
import type { Output } from "../context.js";
import { type ProjectLayout, separateSessionTree } from "../project-layout.js";
import { isTicketName } from "./layout.js";

const DEFAULT_ARCHIVE_DAYS = 7;
const DAY_MS = 86_400_000;
const SESSION_TREE_LABEL = " (session tree)";

export function archiveThresholdDays(env: NodeJS.ProcessEnv): number {
  const value = env.ALIGNFIRST_ARCHIVE_DAYS;
  if (value === undefined) return DEFAULT_ARCHIVE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0)
    throw new CliError("ALIGNFIRST_ARCHIVE_DAYS must be a positive number of days.");
  return days;
}

/**
 * Archives the stale entries of `.plans`, and of a separate session tree into its own `_archives`.
 * Returns whether `.plans` changed.
 */
export function autoArchive(layout: ProjectLayout, thresholdDays: number, stdout: Output): boolean {
  const cutoff = Date.now() - thresholdDays * DAY_MS;
  const plansDir = layout.locations[".plans"].path;
  const sessionsDir = separateSessionTree(layout);
  const plansCandidates = staleEntries(plansDir, cutoff);
  const sessionCandidates = sessionsDir === undefined ? [] : staleEntries(sessionsDir, cutoff);
  if (plansCandidates.length === 0 && sessionCandidates.length === 0) {
    stdout.write("Nothing to archive.\n");
    return false;
  }
  for (const candidate of plansCandidates) archiveEntry(plansDir, candidate, stdout);
  if (sessionsDir !== undefined) {
    for (const candidate of sessionCandidates)
      archiveEntry(sessionsDir, candidate, stdout, SESSION_TREE_LABEL);
  }
  return plansCandidates.length > 0;
}

function staleEntries(root: string, cutoff: number): string[] {
  return [...staleTicketDirectories(root, cutoff), ...staleNoTicketSessionFiles(root, cutoff)];
}

function staleTicketDirectories(root: string, cutoff: number): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isTicketName(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((ticketDir) => newestFileMtime(ticketDir) < cutoff);
}

function newestFileMtime(dir: string): number {
  const files = readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) =>
    entry.isFile(),
  );
  if (files.length === 0) return statSync(dir).mtimeMs;
  return Math.max(...files.map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs));
}

function staleNoTicketSessionFiles(root: string, cutoff: number): string[] {
  const sessionDir = join(root, "_aldev");
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(sessionDir, entry.name))
    .filter((path) => statSync(path).mtimeMs < cutoff);
}

/** Archiving ticket `name` also archives its directory in a separate session tree. */
export function archiveTicket(layout: ProjectLayout, name: string, stdout: Output): void {
  const plansDir = layout.locations[".plans"].path;
  archiveEntry(plansDir, join(plansDir, name), stdout);
  const sessionsDir = separateSessionTree(layout);
  if (sessionsDir === undefined) return;
  const sessionTicketDir = join(sessionsDir, name);
  if (existsSync(sessionTicketDir))
    archiveEntry(sessionsDir, sessionTicketDir, stdout, SESSION_TREE_LABEL);
}

function archiveEntry(root: string, sourcePath: string, stdout: Output, label = ""): void {
  const rel = relative(root, sourcePath);
  const archivesDir = join(root, "_archives");
  const targetDir = join(archivesDir, dirname(rel));
  mkdirSync(targetDir, { recursive: true });
  const target = moveToFreeName(sourcePath, targetDir, statSync(sourcePath).isFile());
  stdout.write(`Archived ${rel}${label} → _archives/${relative(archivesDir, target)}\n`);
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
