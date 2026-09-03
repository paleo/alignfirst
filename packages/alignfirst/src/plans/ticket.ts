import { type Dirent, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import { isNodeError } from "../errors.js";
import { gitOutputOrUndefined } from "../git.js";
import { archivesDir, plansDir } from "./layout.js";

const FILE_PREFIX = /^([A-Z])(\d+)-/;
const SIDE_TICKET = /^side-(\d+)$/;
const PATH_SAFE_TICKET = /^[A-Za-z0-9._-]+$/;

export interface ResolvedTicketDir {
  id: string;
  dir: string;
  state: "existing" | "created" | "restored";
  entries: string[];
}

export interface ResolveTicketOptions {
  dryRun: boolean;
}

export interface DeducedTicket {
  id: string;
  branch: string;
}

export function resolveTicketDir(
  cwd: string,
  id: string,
  { dryRun }: ResolveTicketOptions,
): ResolvedTicketDir {
  const dir = join(plansDir(cwd), id);
  if (existsSync(dir)) return { id, dir, state: "existing", entries: listEntries(dir) };
  const archivedDir = join(archivesDir(cwd), id);
  if (existsSync(archivedDir)) {
    const entries = listEntries(archivedDir);
    if (!dryRun) renameSync(archivedDir, dir);
    return { id, dir, state: "restored", entries };
  }
  if (!dryRun) mkdirSync(dir);
  return { id, dir, state: "created", entries: [] };
}

export function reserveSideTicket(cwd: string): string {
  const root = plansDir(cwd);
  const highest = Math.max(highestSideTicket(root), highestSideTicket(archivesDir(cwd)));
  for (let number = highest + 1; ; ++number) {
    const ticket = `side-${number}`;
    try {
      mkdirSync(join(root, ticket));
      return ticket;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
}

export function peekSideTicket(cwd: string): string {
  const root = plansDir(cwd);
  const highest = Math.max(highestSideTicket(root), highestSideTicket(archivesDir(cwd)));
  for (let number = highest + 1; ; ++number) {
    const ticket = `side-${number}`;
    if (!existsSync(join(root, ticket))) return ticket;
  }
}

function highestSideTicket(dir: string): number {
  let highest = 0;
  for (const entry of readEntries(dir)) {
    const match = entry.isDirectory() ? SIDE_TICKET.exec(entry.name) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function nextFileName(dir: string, filename: string, newCycle: boolean): string {
  const prefixes = readEntries(dir).flatMap((entry) => {
    const match = FILE_PREFIX.exec(entry.name);
    return match ? [{ cycle: match[1], number: Number(match[2]) }] : [];
  });
  if (prefixes.length === 0) return `A1-${filename}`;
  const highestCycle = prefixes.reduce(
    (highest, prefix) => (prefix.cycle > highest ? prefix.cycle : highest),
    "A",
  );
  if (newCycle) return `${String.fromCharCode(highestCycle.charCodeAt(0) + 1)}1-${filename}`;
  const highestNumber = Math.max(
    ...prefixes.filter(({ cycle }) => cycle === highestCycle).map(({ number }) => number),
  );
  return `${highestCycle}${highestNumber + 1}-${filename}`;
}

export function listEntries(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .toSorted();
}

export function isPathSafeTicketId(id: string): boolean {
  return id !== "." && !id.includes("..") && PATH_SAFE_TICKET.test(id);
}

export function validateTicketId(id: string, pattern?: string): void {
  if (!isPathSafeTicketId(id)) throw new CliError(`Invalid ticket id: ${id}`);
  if (pattern !== undefined && !new RegExp(pattern).test(id) && !SIDE_TICKET.test(id))
    throw new CliError(`Ticket id "${id}" does not match ticketPattern "${pattern}".`);
}

export function deduceTicketFromBranch(cwd: string, pattern: string): DeducedTicket {
  const branch = gitOutputOrUndefined(cwd, "branch", "--show-current");
  if (branch === undefined || branch === "")
    throw new CliError("Cannot deduce a ticket id from a detached HEAD.");
  const unanchored = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const match = new RegExp(unanchored).exec(branch);
  if (!match)
    throw new CliError(
      `Cannot deduce a ticket id from branch "${branch}" with pattern "${pattern}".`,
    );
  return { id: match[0], branch };
}
