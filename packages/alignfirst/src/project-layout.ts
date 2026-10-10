import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type } from "arktype";

import { CliError } from "./cli-error.js";
import type { CommandContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { gitOutputOrUndefined } from "./git.js";

export const ITEM_NAMES = [
  ".alignfirst.json",
  ".alignfirst-instructions",
  "DEVELOPERS.md",
  "docs",
  ".plans",
  "_aligndev",
] as const;
// The directory holding the companions and their registry. A symlink there moves them elsewhere.
const COMPANIONS_ROOT = "~/.alignfirst/companions";
const REGISTRY_FILE = "registry.json";

const FLAG = "boolean | 'auto'";
const flagsSchema = type({
  "+": "reject",
  ".alignfirst.json?": FLAG,
  ".alignfirst-instructions?": FLAG,
  "DEVELOPERS.md?": FLAG,
  "docs?": FLAG,
  ".plans?": FLAG,
  "_aligndev?": FLAG,
});
const registrySchema = type({
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
  /** The registry key, as written. */
  key: string;
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

interface Registry {
  path: string;
  paths: Record<string, Partial<Record<ItemName, Flag>>>;
}

interface RegistryEntry {
  key: string;
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
  const registry = readRegistry(home);
  if (registry === undefined) return null;
  const mainWorktree = findMainWorktree(cwd);
  if (mainWorktree === undefined) return null;
  const realHome = realOrResolved(home);
  const entry = findEntry(registry, mainWorktree, realHome);
  if (entry === undefined) return null;
  const flags = effectiveFlags(entry);
  assertValidFlags(registry, flags, entry);
  const dir = companionDir(mainWorktree, realHome);
  return { dir, exists: pathExists(dir), key: entry.key, flags };
}

function readRegistry(home: string): Registry | undefined {
  const path = registryPath(home);
  if (!pathExists(path)) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw invalidRegistry(path, errorMessage(error));
  }
  const file = registrySchema(value);
  if (file instanceof type.errors) throw invalidRegistry(path, file.summary.split("\n", 1)[0]);
  const badKey = Object.keys(file.paths).find((key) => !isUserPath(key));
  if (badKey !== undefined)
    throw invalidRegistry(path, `paths key must be an absolute path or start with ~/: ${badKey}`);
  return { path, paths: file.paths };
}

export function registryPath(home: string): string {
  return join(home, ".alignfirst", "companions", REGISTRY_FILE);
}

function invalidRegistry(path: string, detail: string): CliError {
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

function findEntry(
  registry: Registry,
  mainWorktree: string,
  realHome: string,
): RegistryEntry | undefined {
  const key = Object.keys(registry.paths).find(
    (candidate) => normalizePath(candidate, realHome) === mainWorktree,
  );
  return key === undefined ? undefined : { key, flags: registry.paths[key] };
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function effectiveFlags(entry: RegistryEntry): Record<ItemName, Flag> {
  const flagOf = (item: ItemName): Flag => entry.flags[item] ?? "auto";
  return {
    ".alignfirst.json": flagOf(".alignfirst.json"),
    ".alignfirst-instructions": flagOf(".alignfirst-instructions"),
    "DEVELOPERS.md": flagOf("DEVELOPERS.md"),
    docs: flagOf("docs"),
    ".plans": flagOf(".plans"),
    _aligndev: flagOf("_aligndev"),
  };
}

function assertValidFlags(
  registry: Registry,
  flags: Record<ItemName, Flag>,
  entry: RegistryEntry,
): void {
  if (flags._aligndev !== true || flags[".plans"] !== "auto") return;
  throw invalidRegistry(
    registry.path,
    `"_aligndev": true requires ".plans" set to true or false (key: ${entry.key})`,
  );
}

function companionDir(mainWorktree: string, realHome: string): string {
  return join(normalizePath(COMPANIONS_ROOT, realHome), companionName(mainWorktree, realHome));
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
    ".alignfirst-instructions": locate(".alignfirst-instructions"),
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

export interface CompanionRegistration {
  registry: string;
  /** The key added, or the key already present. */
  key: string;
  added: boolean;
  /** Absolute. */
  dir: string;
  exists: boolean;
  created: boolean;
}

/**
 * Registers the main worktree of `cwd` with every item on `"auto"`, unless it is registered.
 * Creates the registry when it is missing, and the companion directory with `createDir`.
 */
export function registerCompanion(
  cwd: string,
  home: string,
  { createDir }: { createDir: boolean },
): CompanionRegistration {
  const mainWorktree = requireMainWorktree(cwd);
  const realHome = realOrResolved(home);
  const registry = readRegistry(home) ?? { path: registryPath(home), paths: {} };
  const entry = findEntry(registry, mainWorktree, realHome);
  const key = entry?.key ?? userPathOf(mainWorktree, realHome);
  const dir = companionDir(mainWorktree, realHome);
  if (entry === undefined) {
    assertOwnCompanionDir(registry, key, dir, realHome);
    writeRegistry(registry.path, { ...registry.paths, [key]: {} });
  }
  const created = createDir && !pathExists(dir);
  if (created) mkdirSync(dir, { recursive: true });
  return {
    registry: registry.path,
    key,
    added: entry === undefined,
    dir,
    exists: pathExists(dir),
    created,
  };
}

function requireMainWorktree(cwd: string): string {
  const mainWorktree = findMainWorktree(cwd);
  if (mainWorktree === undefined)
    throw new CliError("A companion needs a git repository with a main worktree.");
  return mainWorktree;
}

function userPathOf(path: string, realHome: string): string {
  if (path === realHome) return "~";
  return isSameOrInside(path, realHome) ? `~/${relative(realHome, path)}` : path;
}

/** Two keys collide when their names differ only by a `_` in place of a `/`. */
function assertOwnCompanionDir(
  registry: Registry,
  key: string,
  dir: string,
  realHome: string,
): void {
  const others = (keysByCompanionDir(registry, realHome).get(dir) ?? []).filter((k) => k !== key);
  if (others.length === 0) return;
  throw new CliError(`The companion directory ${dir} is already used by ${others.join(", ")}.`);
}

function keysByCompanionDir(registry: Registry, realHome: string): Map<string, string[]> {
  const keysByDir = new Map<string, string[]>();
  for (const key of Object.keys(registry.paths)) {
    const dir = companionDir(normalizePath(key, realHome), realHome);
    keysByDir.set(dir, [...(keysByDir.get(dir) ?? []), key]);
  }
  return keysByDir;
}

function writeRegistry(path: string, paths: Registry["paths"]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ paths }, undefined, 2)}\n`);
  renameSync(tmpPath, path);
}

export interface CompanionUnregistration {
  registry: string;
  key: string;
  /** Absolute. */
  dir: string;
  /** `undefined` when the directory is missing. */
  empty?: boolean;
  removed: boolean;
}

/**
 * Removes the registry key of the main worktree of `cwd`. With `removeDir`, also removes its
 * companion directory: a non-empty one requires `force`. Fails before any change.
 */
export function unregisterCompanion(
  cwd: string,
  home: string,
  { removeDir, force }: { removeDir: boolean; force: boolean },
): CompanionUnregistration {
  const mainWorktree = requireMainWorktree(cwd);
  const realHome = realOrResolved(home);
  const path = registryPath(home);
  const registry = readRegistry(home);
  const entry = registry && findEntry(registry, mainWorktree, realHome);
  if (!registry || entry === undefined)
    throw new CliError(`${mainWorktree} is not registered in ${path}.`);
  const dir = companionDir(mainWorktree, realHome);
  const entries = pathExists(dir) ? readdirSync(dir) : undefined;
  if (removeDir) assertRemovableDir(registry, entry.key, dir, entries, force, realHome);
  const { [entry.key]: _removed, ...paths } = registry.paths;
  writeRegistry(path, paths);
  const removed = removeDir && entries !== undefined;
  if (removed) rmSync(dir, { recursive: true, force: true });
  return { registry: path, key: entry.key, dir, empty: entries && entries.length === 0, removed };
}

function assertRemovableDir(
  registry: Registry,
  key: string,
  dir: string,
  entries: string[] | undefined,
  force: boolean,
  realHome: string,
): void {
  assertOwnCompanionDir(registry, key, dir, realHome);
  if (force || entries === undefined || entries.length === 0) return;
  throw new CliError(
    `The companion directory ${dir} is not empty: ${entries.sort().join(", ")}. ` +
      "Add --force to delete it.",
  );
}

/** The registry keys that name no git main worktree: they match nothing. */
export function strayRegistryKeys(home: string): string[] {
  const registry = readRegistry(home);
  if (registry === undefined) return [];
  const realHome = realOrResolved(home);
  return Object.keys(registry.paths).filter((key) => {
    const path = normalizePath(key, realHome);
    return !existsSync(path) || findMainWorktree(path) !== path;
  });
}

/** The companion directories shared by several registry keys, with those keys. */
export function sharedCompanionDirs(home: string): { dir: string; keys: string[] }[] {
  const registry = readRegistry(home);
  if (registry === undefined) return [];
  return [...keysByCompanionDir(registry, realOrResolved(home))]
    .filter(([, keys]) => keys.length > 1)
    .map(([dir, keys]) => ({ dir, keys }));
}
