import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  type Stats,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { CliError } from "../cli-error.js";
import { isNodeError } from "../errors.js";
import { formatLocalTimestamp } from "../format.js";
import { gitOutputOrUndefined } from "../git.js";
import { type ProjectLayout, separateSessionTree } from "../project-layout.js";
import { archivesDir, isTicketName } from "./layout.js";

const FILE_PREFIX = /^([A-Z])(\d+)-/;
const SIDE_TICKET = /^side-(\d+)$/;
const BRANCH_SEPARATORS = "[/_.-]";
const SIDE_TICKET_BRANCH = new RegExp(`^side-\\d+(?=$|${BRANCH_SEPARATORS})`);
const PATH_SAFE_TICKET = /^[A-Za-z0-9._-]+$/;
const ENTRY_ORDER = new Intl.Collator("en", { numeric: true });
const LISTED_TICKETS = 10;

export interface ResolvedTicketDir {
  id: string;
  dir: string;
  state: "existing" | "created" | "restored";
  entries: TicketEntry[];
}

/** `name` ends with a slash for a directory, which has no `size`. */
export interface TicketEntry {
  name: string;
  size?: number;
  modifiedAt: Date;
}

export interface ResolveTicketOptions {
  dryRun: boolean;
}

export interface DeducedTicket {
  id: string;
  branch: string;
}

export type TicketDetection =
  | { kind: "detected"; id: string; branch: string }
  | { kind: "noMatch"; branch: string }
  | { kind: "noBranch" };

export function resolveTicketDir(
  plansPath: string,
  id: string,
  { dryRun }: ResolveTicketOptions,
): ResolvedTicketDir {
  const dir = join(plansPath, id);
  if (existsSync(dir)) return { id, dir, state: "existing", entries: listEntries(dir) };
  const archivedDir = join(archivesDir(plansPath), id);
  if (existsSync(archivedDir)) {
    const entries = listEntries(archivedDir);
    if (!dryRun) renameSync(archivedDir, dir);
    return { id, dir, state: "restored", entries };
  }
  if (!dryRun) mkdirSync(dir);
  return { id, dir, state: "created", entries: [] };
}

/** Restores ticket `id` in a separate session tree, when only its archived copy exists. */
export function restoreSessionTreeTicket(layout: ProjectLayout, id: string): void {
  const sessionsDir = separateSessionTree(layout);
  if (sessionsDir === undefined) return;
  const dir = join(sessionsDir, id);
  const archivedDir = join(archivesDir(sessionsDir), id);
  if (!existsSync(dir) && existsSync(archivedDir)) renameSync(archivedDir, dir);
}

export function reserveSideTicket(plansPath: string): string {
  for (let number = highestSideTicket(plansPath) + 1; ; ++number) {
    const ticket = `side-${number}`;
    try {
      mkdirSync(join(plansPath, ticket));
      return ticket;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
}

export function peekSideTicket(plansPath: string): string {
  for (let number = highestSideTicket(plansPath) + 1; ; ++number) {
    const ticket = `side-${number}`;
    if (!existsSync(join(plansPath, ticket))) return ticket;
  }
}

function highestSideTicket(plansPath: string): number {
  return Math.max(highestSideTicketIn(plansPath), highestSideTicketIn(archivesDir(plansPath)));
}

function highestSideTicketIn(dir: string): number {
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

export interface NextFilePosition {
  cycleLetter: string;
  fileNumber: number;
}

export function nextFilePosition(entries: readonly string[], newCycle: boolean): NextFilePosition {
  const prefixes = entries.flatMap((entry) => {
    const match = FILE_PREFIX.exec(entry);
    return match ? [{ cycle: match[1], number: Number(match[2]) }] : [];
  });
  if (prefixes.length === 0) return { cycleLetter: "A", fileNumber: 1 };
  const highestCycle = prefixes.reduce(
    (highest, prefix) => (prefix.cycle > highest ? prefix.cycle : highest),
    "A",
  );
  if (newCycle)
    return { cycleLetter: String.fromCharCode(highestCycle.charCodeAt(0) + 1), fileNumber: 1 };
  const highestNumber = Math.max(
    ...prefixes.filter(({ cycle }) => cycle === highestCycle).map(({ number }) => number),
  );
  return { cycleLetter: highestCycle, fileNumber: highestNumber + 1 };
}

export function listEntries(dir: string): TicketEntry[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .map((name) => describeEntry(join(dir, name)))
    .toSorted((left, right) => ENTRY_ORDER.compare(left.name, right.name));
}

function describeEntry(path: string): TicketEntry {
  const stat = statOrLink(path);
  if (stat.isDirectory()) return { name: `${basename(path)}/`, modifiedAt: stat.mtime };
  return { name: basename(path), size: stat.size, modifiedAt: stat.mtime };
}

function statOrLink(path: string): Stats {
  try {
    return statSync(path);
  } catch {
    return lstatSync(path);
  }
}

export function isPathSafeTicketId(id: string): boolean {
  return id !== "." && !id.includes("..") && PATH_SAFE_TICKET.test(id);
}

export function validateTicketId(id: string): void {
  if (!isPathSafeTicketId(id) || !isTicketName(id)) throw new CliError(`Invalid ticket id: ${id}`);
}

export function detectTicketFromBranch(
  cwd: string,
  pattern?: string,
  template?: string,
): TicketDetection {
  const branch = currentBranch(cwd);
  if (branch === undefined) return { kind: "noBranch" };
  const sideTicket = SIDE_TICKET_BRANCH.exec(branch);
  if (sideTicket) return { kind: "detected", id: sideTicket[0], branch };
  if (pattern === undefined) return { kind: "noMatch", branch };
  if (template?.includes("{TICKET_ID}")) {
    const match = branchPatternFromTemplate(template, unanchorPattern(pattern)).exec(branch);
    const id = match?.[1];
    if (id === undefined || !isPathSafeTicketId(id) || !isTicketName(id))
      return { kind: "noMatch", branch };
    return { kind: "detected", id, branch };
  }
  const match = new RegExp(unanchorPattern(pattern)).exec(branch);
  if (!match) return { kind: "noMatch", branch };
  return { kind: "detected", id: match[0], branch };
}

function unanchorPattern(pattern: string): string {
  return pattern.replace(/^\^/, "").replace(/\$$/, "");
}

function branchPatternFromTemplate(template: string, ticketPattern: string): RegExp {
  const placeholder = /\{[^{}]+\}/g;
  let source = "";
  let cursor = 0;
  for (const match of template.matchAll(placeholder)) {
    source += escapeRegexLiteral(template.slice(cursor, match.index));
    source += match[0] === "{TICKET_ID}" ? `((?:${ticketPattern})|side-\\d+)` : ".+";
    cursor = match.index + match[0].length;
  }
  source += escapeRegexLiteral(template.slice(cursor));
  return new RegExp(`^${source}$`);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentBranch(cwd: string): string | undefined {
  const branch = gitOutputOrUndefined(cwd, "branch", "--show-current");
  return branch === undefined || branch === "" ? undefined : branch;
}

export interface DeduceFromExistingOptions {
  sideAllowed: boolean;
}

/** Without a ticket id pattern, the branch can still name an existing ticket directory. */
export function deduceTicketFromExisting(
  cwd: string,
  plansPath: string,
  { sideAllowed }: DeduceFromExistingOptions,
): DeducedTicket {
  const tickets = listTickets(plansPath);
  const branch = currentBranch(cwd);
  if (branch !== undefined) {
    const matches = tickets.filter((ticket) => branchNamesTicket(branch, ticket.id));
    if (matches.length === 1) return { id: matches[0].id, branch };
  }
  throw new CliError(renderMissingTicketId(tickets, sideAllowed));
}

interface ExistingTicket {
  id: string;
  archived: boolean;
  modifiedAt: Date;
}

function listTickets(plansPath: string): ExistingTicket[] {
  return [
    ...ticketDirectories(plansPath, false),
    ...ticketDirectories(archivesDir(plansPath), true),
  ].toSorted((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
}

function ticketDirectories(dir: string, archived: boolean): ExistingTicket[] {
  return readEntries(dir)
    .filter((entry) => entry.isDirectory() && isTicketName(entry.name))
    .map((entry) => ({
      id: entry.name,
      archived,
      modifiedAt: newestModification(join(dir, entry.name)),
    }));
}

function newestModification(dir: string): Date {
  const entries = listEntries(dir);
  if (entries.length === 0) return statSync(dir).mtime;
  return new Date(Math.max(...entries.map((entry) => entry.modifiedAt.getTime())));
}

function branchNamesTicket(branch: string, id: string): boolean {
  const escaped = escapeRegexLiteral(id);
  return new RegExp(`(^|${BRANCH_SEPARATORS})${escaped}($|${BRANCH_SEPARATORS})`).test(branch);
}

function renderMissingTicketId(tickets: ExistingTicket[], sideAllowed: boolean): string {
  const hint = sideAllowed
    ? "Pass a ticket id, or --side for a new side ticket."
    : "Pass a ticket id.";
  if (tickets.length === 0) return `No ticket id given. ${hint}`;
  const listed = tickets.slice(0, LISTED_TICKETS);
  const width = Math.max(...listed.map((ticket) => ticket.id.length));
  const lines = listed.map(
    (ticket) =>
      `  ${ticket.id.padEnd(width)}  ${formatLocalTimestamp(ticket.modifiedAt)}` +
      (ticket.archived ? " (archived)" : ""),
  );
  const rest = tickets.length - listed.length;
  if (rest > 0) lines.push(`  … ${rest} more`);
  return `No ticket id given. Existing tickets:\n${lines.join("\n")}\n${hint}`;
}
