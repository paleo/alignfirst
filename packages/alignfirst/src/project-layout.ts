import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type } from "arktype";

import { CliError } from "./cli-error.js";
import type { CommandContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { gitOutputOrUndefined } from "./git.js";

export const ITEM_NAMES = [
  ".alignfirst.json",
  ".alignfirst.md",
  "DEVELOPERS.md",
  "docs",
  ".plans",
  "_aligndev",
] as const;
// The directory holding the companions. A symlink there moves them elsewhere.
const COMPANIONS_ROOT = "~/.alignfirst/companions";

const FLAG = "boolean | 'auto'";
const flagsSchema = type({
  "+": "reject",
  ".alignfirst.json?": FLAG,
  ".alignfirst.md?": FLAG,
  "DEVELOPERS.md?": FLAG,
  "docs?": FLAG,
  ".plans?": FLAG,
  "_aligndev?": FLAG,
});
const companionsSchema = type({
  "+": "reject",
  paths: type.Record("string", flagsSchema),
});

export type ItemName = (typeof ITEM_NAMES)[number];
export type Flag = boolean | "auto";

export interface ProjectLayout {
  companion: CompanionLayout | null;
  locations: Record<ItemName, ItemLocation>;
}

export interface CompanionLayout {
  /** Absolute. */
  dir: string;
  exists: boolean;
  /** Matching keys as written, most specific first. */
  entries: string[];
  /** Effective flags. */
  flags: Record<ItemName, Flag>;
}

export interface ItemLocation {
  /** Absolute. */
  path: string;
  in: "project" | "companion";
  exists: boolean;
}

type FileItemName = Exclude<ItemName, "_aligndev">;

interface CompanionsFile {
  path: string;
  paths: Record<string, Partial<Record<ItemName, Flag>>>;
}

interface MatchingEntry {
  key: string;
  path: string;
  flags: Partial<Record<ItemName, Flag>>;
}

export function layoutOf(ctx: CommandContext): ProjectLayout {
  ctx.layout ??= resolveProjectLayout(ctx.cwd, ctx.home);
  return ctx.layout;
}

export function resolveProjectLayout(cwd: string, home: string): ProjectLayout {
  const companion = resolveCompanion(cwd, home);
  return { companion, locations: resolveLocations(cwd, companion) };
}

function resolveCompanion(cwd: string, home: string): CompanionLayout | null {
  const file = readCompanionsFile(home);
  if (file === undefined) return null;
  const mainWorktree = findMainWorktree(cwd);
  if (mainWorktree === undefined) return null;
  const realHome = realOrResolved(home);
  const matches = matchingEntries(file, mainWorktree, realHome);
  if (matches.length === 0) return null;
  const flags = mergeFlags(matches);
  assertValidFlags(file, flags, matches);
  const dir = join(normalizePath(COMPANIONS_ROOT, realHome), companionName(mainWorktree, realHome));
  return { dir, exists: pathExists(dir), entries: matches.map((match) => match.key), flags };
}

function readCompanionsFile(home: string): CompanionsFile | undefined {
  const path = companionsPath(home);
  if (!pathExists(path)) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw invalidCompanions(path, errorMessage(error));
  }
  const file = companionsSchema(value);
  if (file instanceof type.errors) throw invalidCompanions(path, file.summary.split("\n", 1)[0]);
  const badKey = Object.keys(file.paths).find((key) => !isUserPath(key));
  if (badKey !== undefined)
    throw invalidCompanions(path, `paths key must be an absolute path or start with ~/: ${badKey}`);
  return { path, paths: file.paths };
}

export function companionsPath(home: string): string {
  return join(home, ".alignfirst", "companions.json");
}

function invalidCompanions(path: string, detail: string): CliError {
  return new CliError(`Invalid ${path}: ${detail}`);
}

function isUserPath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || isAbsolute(value);
}

/** The main worktree is the parent of the common `.git` directory; a bare repository has none. */
function findMainWorktree(cwd: string): string | undefined {
  const commonDir = gitOutputOrUndefined(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (commonDir === undefined || basename(commonDir) !== ".git") return;
  return realpathSync(dirname(commonDir));
}

function normalizePath(value: string, realHome: string): string {
  if (value === "~") return realHome;
  return realOrResolved(value.startsWith("~/") ? join(realHome, value.slice(2)) : value);
}

function realOrResolved(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function matchingEntries(
  file: CompanionsFile,
  mainWorktree: string,
  realHome: string,
): MatchingEntry[] {
  return Object.entries(file.paths)
    .map(([key, flags]) => ({ key, path: normalizePath(key, realHome), flags }))
    .filter((entry) => isSameOrInside(mainWorktree, entry.path))
    .toSorted((left, right) => right.path.length - left.path.length);
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function mergeFlags(matches: MatchingEntry[]): Record<ItemName, Flag> {
  const flagOf = (item: ItemName): Flag =>
    matches.find((match) => match.flags[item] !== undefined)?.flags[item] ?? "auto";
  return {
    ".alignfirst.json": flagOf(".alignfirst.json"),
    ".alignfirst.md": flagOf(".alignfirst.md"),
    "DEVELOPERS.md": flagOf("DEVELOPERS.md"),
    docs: flagOf("docs"),
    ".plans": flagOf(".plans"),
    _aligndev: flagOf("_aligndev"),
  };
}

function assertValidFlags(
  file: CompanionsFile,
  flags: Record<ItemName, Flag>,
  matches: MatchingEntry[],
): void {
  if (flags._aligndev !== true || flags[".plans"] !== "auto") return;
  const keys = matches.map((match) => match.key).join(", ");
  throw invalidCompanions(
    file.path,
    `"_aligndev": true requires ".plans" set to true or false (matching keys: ${keys})`,
  );
}

function companionName(mainWorktree: string, realHome: string): string {
  const name =
    mainWorktree !== realHome && isSameOrInside(mainWorktree, realHome)
      ? relative(realHome, mainWorktree)
      : mainWorktree.slice(1);
  return name.replaceAll("/", "_");
}

function resolveLocations(
  cwd: string,
  companion: CompanionLayout | null,
): Record<ItemName, ItemLocation> {
  const locate = (name: FileItemName) => locateItem(cwd, companion, name);
  const plans = locate(".plans");
  return {
    ".alignfirst.json": locate(".alignfirst.json"),
    ".alignfirst.md": locate(".alignfirst.md"),
    "DEVELOPERS.md": locate("DEVELOPERS.md"),
    docs: locate("docs"),
    ".plans": plans,
    _aligndev: companion?.flags._aligndev === true ? companionCopy(companion, ".plans") : plans,
  };
}

function locateItem(
  cwd: string,
  companion: CompanionLayout | null,
  name: FileItemName,
): ItemLocation {
  const project = projectCopy(cwd, name);
  if (companion === null || companion.flags[name] === false) return project;
  const copy = companionCopy(companion, name);
  if (companion.flags[name] === true || copy.exists || !project.exists) return copy;
  return project;
}

function projectCopy(cwd: string, name: string): ItemLocation {
  const path = join(cwd, name);
  return { path, in: "project", exists: pathExists(path) };
}

function companionCopy(companion: CompanionLayout, name: string): ItemLocation {
  const path = join(companion.dir, name);
  return { path, in: "companion", exists: pathExists(path) };
}

/** An lstat check, so a broken `.plans` symlink still resolves in place. */
function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** One line: `<name>: <path> (<in>)`, with `, missing` when absent. */
export function renderItemLocation(name: ItemName, location: ItemLocation): string {
  return `${name}: ${location.path} (${location.in}${location.exists ? "" : ", missing"})`;
}

/** The `_aligndev` tree when it is not the resolved `.plans` and exists. */
export function separateSessionTree(layout: ProjectLayout): string | undefined {
  const sessions = layout.locations._aligndev;
  if (!sessions.exists || sessions.path === layout.locations[".plans"].path) return;
  return sessions.path;
}
