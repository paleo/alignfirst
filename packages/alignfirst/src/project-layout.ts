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

import { CliError } from "./cli-error.js";
import type { CommandContext } from "./context.js";
import { errorMessage } from "./errors.js";
import { gitOutputOrUndefined } from "./git.js";
import {
  literal,
  nonEmptyString,
  object,
  optional,
  parseShape,
  record,
  shapeError,
} from "./json-shape.js";

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
const OLD_SHAPE_DETAIL =
  'the companion registry now uses "projects" entries with a "dir". Convert it as the ' +
  "alignfirst-upgrade reference of the alignfirst-setup-guide skill describes.";

const itemSetting = literal("companion", "project", "auto");
const registryFileShape = object<RegistryFile>({
  projects: record(
    object<RegistryProject>({
      dir: dirValue,
      items: optional(
        object<RegistryItems>({
          ".alignfirst.json": optional(itemSetting),
          ".alignfirst-instructions": optional(itemSetting),
          "DEVELOPERS.md": optional(itemSetting),
          docs: optional(itemSetting),
          ".plans": optional(itemSetting),
          _aligndev: optional(literal("companion", "auto")),
        }),
      ),
    }),
  ),
});

export type ItemName = (typeof ITEM_NAMES)[number];

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
  /** Effective settings: an item the entry does not set is `"auto"`. */
  items: ItemSettings;
}

export type ItemSettings = Record<ItemName, ItemSetting | AligndevSetting>;
export type ItemSetting = "companion" | "project" | "auto";
export type AligndevSetting = "companion" | "auto";

export interface ItemLocation {
  /** Absolute. */
  path: string;
  in: "project" | "companion";
  exists: boolean;
}

type FileItemName = Exclude<ItemName, "_aligndev">;

interface RegistryFile {
  projects: Record<string, RegistryProject>;
}

interface RegistryProject {
  /** Relative to the real companions directory, or `~/…`, or absolute. */
  dir: string;
  items?: RegistryItems;
}

interface RegistryItems {
  ".alignfirst.json"?: ItemSetting;
  ".alignfirst-instructions"?: ItemSetting;
  "DEVELOPERS.md"?: ItemSetting;
  docs?: ItemSetting;
  ".plans"?: ItemSetting;
  _aligndev?: AligndevSetting;
}

interface Registry extends RegistryFile {
  path: string;
}

interface RegistryEntry {
  key: string;
  project: RegistryProject;
  /** The resolved `dir`. */
  dir: string;
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
  const items = effectiveItems(entry.project);
  assertValidItems(registry, items, entry);
  return { dir: entry.dir, exists: pathExists(entry.dir), key: entry.key, items };
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
  if (hasOldShape(value)) throw invalidRegistry(path, OLD_SHAPE_DETAIL);
  const file = parseShape(registryFileShape, value, (detail) => invalidRegistry(path, detail));
  const badKey = Object.keys(file.projects).find((key) => !isUserPath(key));
  if (badKey !== undefined)
    throw invalidRegistry(
      path,
      `projects key must be an absolute path or start with ~/: ${badKey}`,
    );
  return { path, projects: file.projects };
}

/** The shape before explicit directories: `{ "paths": { "<key>": { "<item>": true } } }`. */
function hasOldShape(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "paths");
}

export function registryPath(home: string): string {
  return join(home, ".alignfirst", "companions", REGISTRY_FILE);
}

function invalidRegistry(path: string, detail: string): CliError {
  return new CliError(`Invalid ${path}: ${detail}`);
}

function dirValue(value: unknown, path: string): string {
  const dir = nonEmptyString(value, path);
  if (dir.startsWith("~") && !dir.startsWith("~/"))
    throw shapeError(path, "be a relative path, an absolute path or start with ~/");
  return dir;
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
  const key = Object.keys(registry.projects).find(
    (candidate) => normalizePath(candidate, realHome) === mainWorktree,
  );
  if (key === undefined) return;
  const project = registry.projects[key];
  return { key, project, dir: companionDir(project.dir, realHome) };
}

/** A relative `dir` joins the real companions directory, so a symlink there moves it too. */
function companionDir(dir: string, realHome: string): string {
  if (dir.startsWith("~/") || isAbsolute(dir)) return normalizePath(dir, realHome);
  return realOrResolved(join(normalizePath(COMPANIONS_ROOT, realHome), dir));
}

function effectiveItems({ items = {} }: RegistryProject): ItemSettings {
  return {
    ".alignfirst.json": items[".alignfirst.json"] ?? "auto",
    ".alignfirst-instructions": items[".alignfirst-instructions"] ?? "auto",
    "DEVELOPERS.md": items["DEVELOPERS.md"] ?? "auto",
    docs: items.docs ?? "auto",
    ".plans": items[".plans"] ?? "auto",
    _aligndev: items._aligndev ?? "auto",
  };
}

function assertValidItems(registry: Registry, items: ItemSettings, entry: RegistryEntry): void {
  if (items._aligndev !== "companion" || items[".plans"] !== "auto") return;
  throw invalidRegistry(
    registry.path,
    `"_aligndev": "companion" requires ".plans" set to "companion" or "project" (key: ${entry.key})`,
  );
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
    _aligndev:
      companion?.items._aligndev === "companion" ? companionCopy(companion, ".plans") : plans,
  };
}

function locateItem(
  cwd: string,
  companion: CompanionLayout | null,
  name: FileItemName,
): ItemLocation {
  const project = projectCopy(cwd, name);
  if (companion === null || companion.items[name] === "project") return project;
  const copy = companionCopy(companion, name);
  if (companion.items[name] === "companion" || copy.exists || !project.exists) return copy;
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

/** One line: `<name>: <path> (<in>)`, with `, missing` when absent and the setting after the name. */
export function renderItemLocation(
  name: ItemName,
  location: ItemLocation,
  setting?: ItemSetting | AligndevSetting,
): string {
  const label = setting === undefined ? name : `${name} (${setting})`;
  return `${label}: ${location.path} (${location.in}${location.exists ? "" : ", missing"})`;
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

export interface CompanionRegistrationOptions {
  /** The `dir` of a new entry, as written; defaults to the companion name. */
  dir?: string;
  createDir: boolean;
}

/**
 * Registers the main worktree of `cwd` with every item on `"auto"`, unless it is registered.
 * Creates the registry when it is missing, and the companion directory with `createDir`.
 */
export function registerCompanion(
  cwd: string,
  home: string,
  options: CompanionRegistrationOptions,
): CompanionRegistration {
  const mainWorktree = requireMainWorktree(cwd);
  const realHome = realOrResolved(home);
  const registry = readRegistry(home) ?? { path: registryPath(home), projects: {} };
  const registered = findEntry(registry, mainWorktree, realHome);
  if (registered !== undefined && options.dir !== undefined)
    assertRegisteredDir(registered, options.dir, realHome);
  const entry = registered ?? addEntry(registry, mainWorktree, realHome, options.dir);
  const created = options.createDir && !pathExists(entry.dir);
  if (created) mkdirSync(entry.dir, { recursive: true });
  return {
    registry: registry.path,
    key: entry.key,
    added: registered === undefined,
    dir: entry.dir,
    exists: pathExists(entry.dir),
    created,
  };
}

function requireMainWorktree(cwd: string): string {
  const mainWorktree = findMainWorktree(cwd);
  if (mainWorktree === undefined)
    throw new CliError("A companion needs a git repository with a main worktree.");
  return mainWorktree;
}

function assertRegisteredDir(entry: RegistryEntry, dirOption: string, realHome: string): void {
  const dir = companionDir(checkDirOption(dirOption), realHome);
  if (dir === entry.dir) return;
  throw new CliError(
    `--dir resolves to ${dir}, but ${entry.key} is registered with the companion directory ` +
      `${entry.dir}.`,
  );
}

function checkDirOption(dirOption: string): string {
  return parseShape(dirValue, dirOption, (detail) => new CliError(`Invalid --dir: ${detail}`));
}

function addEntry(
  registry: Registry,
  mainWorktree: string,
  realHome: string,
  dirOption: string | undefined,
): RegistryEntry {
  const key = userPathOf(mainWorktree, realHome);
  const project: RegistryProject = {
    dir:
      dirOption === undefined ? companionName(mainWorktree, realHome) : checkDirOption(dirOption),
  };
  const dir = companionDir(project.dir, realHome);
  assertOwnCompanionDir(registry, key, dir, realHome);
  writeRegistry(registry.path, { ...registry.projects, [key]: project });
  return { key, project, dir };
}

function userPathOf(path: string, realHome: string): string {
  if (path === realHome) return "~";
  return isSameOrInside(path, realHome) ? `~/${relative(realHome, path)}` : path;
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/** The default `dir` of `companion register`. */
function companionName(mainWorktree: string, realHome: string): string {
  const name =
    mainWorktree !== realHome && isSameOrInside(mainWorktree, realHome)
      ? relative(realHome, mainWorktree)
      : mainWorktree.slice(1);
  return name.replaceAll("/", "_");
}

/** Two keys share a directory only when their `dir` values resolve to the same path. */
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
  for (const [key, project] of Object.entries(registry.projects)) {
    const dir = companionDir(project.dir, realHome);
    keysByDir.set(dir, [...(keysByDir.get(dir) ?? []), key]);
  }
  return keysByDir;
}

function writeRegistry(path: string, projects: Record<string, RegistryProject>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  const file: RegistryFile = { projects };
  writeFileSync(tmpPath, `${JSON.stringify(file, undefined, 2)}\n`);
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
  const { dir } = entry;
  const entries = pathExists(dir) ? readdirSync(dir) : undefined;
  if (removeDir) assertRemovableDir(registry, entry.key, dir, entries, force, realHome);
  const { [entry.key]: _removed, ...projects } = registry.projects;
  writeRegistry(path, projects);
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
  return Object.keys(registry.projects).filter((key) => {
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
