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
import { warnUnknownSetting } from "./settings-warning.js";

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

const itemSetting = literal("companion", "project", "auto");
const registryProjectShape = object<RegistryProject>(
  {
    dir: optional(dirValue),
    aligndev: optional(
      object<AligndevProjectSettings>({ profile: profileValue }, warnUnknownRegistrySetting),
    ),
    items: optional(
      object<RegistryItems>(
        {
          ".alignfirst.json": optional(itemSetting),
          ".alignfirst-instructions": optional(itemSetting),
          "DEVELOPERS.md": optional(itemSetting),
          docs: optional(itemSetting),
          ".plans": optional(itemSetting),
          _aligndev: optional(literal("companion", "auto")),
        },
        warnUnknownRegistrySetting,
      ),
    ),
  },
  warnUnknownRegistrySetting,
);
const registryFileShape = object<RegistryFile>(
  { projects: record(registryProjectValue) },
  warnUnknownRegistrySetting,
);

export type ItemName = (typeof ITEM_NAMES)[number];

export interface ProjectLayout {
  aligndev: AligndevProjectSettings | null;
  companion: CompanionLayout | null;
  locations: Record<ItemName, ItemLocation>;
}

export interface AligndevProjectSettings {
  profile: string;
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
  dir?: string;
  items?: RegistryItems;
  aligndev?: AligndevProjectSettings;
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
  raw: RawRegistryFile;
}

interface RawRegistryFile {
  [key: string]: unknown;
  projects: Record<string, RawRegistryProject>;
}

interface RawRegistryProject {
  [key: string]: unknown;
}

interface RegistryEntry {
  key: string;
  project: RegistryProject;
}

interface CompanionEntry extends RegistryEntry {
  /** The resolved `dir`. */
  dir: string;
}

export function layoutOf(ctx: CommandContext): ProjectLayout {
  ctx.layout ??= resolveProjectLayout(ctx.cwd, ctx.home);
  return ctx.layout;
}

export function resolveProjectLayout(cwd: string, home: string): ProjectLayout {
  const registry = readRegistry(home);
  const mainWorktree = registry && findMainWorktree(cwd);
  const realHome = realOrResolved(home);
  const entry =
    registry && mainWorktree !== undefined
      ? findEntry(registry, mainWorktree, realHome)
      : undefined;
  const companion = registry && entry ? resolveCompanion(registry, entry, realHome) : null;
  return {
    aligndev: entry?.project.aligndev ?? null,
    companion,
    locations: resolveLocations(cwd, companion),
  };
}

function resolveCompanion(
  registry: Registry,
  entry: RegistryEntry,
  realHome: string,
): CompanionLayout | null {
  if (entry.project.dir === undefined) return null;
  const dir = companionDir(entry.project.dir, realHome);
  const items = effectiveItems(entry.project);
  assertValidItems(registry, items, entry);
  return { dir, exists: pathExists(dir), key: entry.key, items };
}

function registryProjectValue(value: unknown, path: string, warningPath = path): RegistryProject {
  const project = registryProjectShape(value, path, warningPath);
  if (project.dir === undefined && project.items !== undefined)
    throw shapeError(path, 'define "dir" when "items" is set');
  if (project.dir === undefined && project.aligndev === undefined)
    throw shapeError(path, 'define "dir" or "aligndev"');
  return project;
}

function profileValue(value: unknown, path: string): string {
  const profile = nonEmptyString(value, path);
  if (profile.trim().length === 0) throw shapeError(path, "be a nonblank profile name");
  return profile;
}

function readRegistry(home: string): Registry | undefined {
  const path = registryPath(home);
  if (!pathExists(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw invalidRegistry(path, errorMessage(error));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidRegistry(path, "must contain valid JSON");
  }
  const file = parseShape(registryFileShape, value, (detail) => invalidRegistry(path, detail));
  const badKey = Object.keys(file.projects).find((key) => !isUserPath(key));
  if (badKey !== undefined)
    throw invalidRegistry(
      path,
      `projects key must be an absolute path or start with ~/: ${badKey}`,
    );
  // The schema validates these object boundaries; retain unknown fields only for mutations.
  const raw = value as RawRegistryFile;
  return { path, projects: file.projects, raw };
}

function warnUnknownRegistrySetting(path: string, key: string): void {
  let hint: string | undefined;
  if (path === "" && key === "paths") {
    hint =
      'The registry now uses "projects" entries with a "dir"; convert paths manually. ' +
      "See the alignfirst-upgrade reference of the alignfirst-setup-guide skill.";
  } else if (path === "" && key === "root") {
    hint = "Use a symlink at ~/.alignfirst/companions or a per-project dir instead.";
  }
  warnUnknownSetting("companion registry", path, key, hint);
}

export function registryPath(home: string): string {
  return join(home, ".alignfirst", "companions", REGISTRY_FILE);
}

function invalidRegistry(path: string, detail: string): CliError {
  return new CliError(`Invalid ${path}: ${detail}`);
}

function dirValue(value: unknown, path: string): string {
  const dir = nonEmptyString(value, path);
  if (dir.trim().length === 0 || dir.includes("\u0000"))
    throw shapeError(path, "be a valid nonblank path");
  if (dir.startsWith("~") && !dir.startsWith("~/"))
    throw shapeError(path, "be a relative path, an absolute path or start with ~/");
  return dir;
}

function isUserPath(value: string): boolean {
  return (
    !value.includes("\u0000") && (value === "~" || value.startsWith("~/") || isAbsolute(value))
  );
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
  return { key, project };
}

/** A relative `dir` joins the real companions directory, so a symlink there moves it too. */
function companionDir(dir: string, realHome: string): string {
  if (dir.startsWith("~/") || isAbsolute(dir)) return normalizePath(dir, realHome);
  return realOrResolved(join(companionsRoot(realHome), dir));
}

function companionsRoot(realHome: string): string {
  return normalizePath(COMPANIONS_ROOT, realHome);
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
  /** The original matched key, or the key added. */
  key: string;
  /** A companion was added, including to an existing profile-only entry. */
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
  const registry = readRegistry(home) ?? {
    path: registryPath(home),
    projects: {},
    raw: { projects: {} },
  };
  const registered = findEntry(registry, mainWorktree, realHome);
  const existing =
    registered?.project.dir === undefined
      ? undefined
      : { ...registered, dir: companionDir(registered.project.dir, realHome) };
  if (existing && options.dir !== undefined) assertRegisteredDir(existing, options.dir, realHome);
  const entry = existing ?? addEntry(registry, mainWorktree, realHome, options.dir, registered);
  const created = options.createDir && !pathExists(entry.dir);
  if (created) mkdirSync(entry.dir, { recursive: true });
  return {
    registry: registry.path,
    key: entry.key,
    added: existing === undefined,
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

function assertRegisteredDir(entry: CompanionEntry, dirOption: string, realHome: string): void {
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
  registered: RegistryEntry | undefined,
): CompanionEntry {
  const key = registered?.key ?? userPathOf(mainWorktree, realHome);
  const dirValue =
    dirOption === undefined ? companionName(mainWorktree, realHome) : checkDirOption(dirOption);
  const project: RegistryProject = { ...registered?.project, dir: dirValue };
  const dir = companionDir(dirValue, realHome);
  assertCompanionDirBounds(registry, { key, project, dir }, mainWorktree, realHome);
  const rawProject = { ...registry.raw.projects[key], dir: dirValue };
  writeRegistry(registry, { ...registry.raw.projects, [key]: rawProject });
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

/**
 * Fails when deleting the companion directory could delete the companions root, the home
 * directory, the project, or another key's companion directory.
 */
function assertCompanionDirBounds(
  registry: Registry,
  { key, dir }: CompanionEntry,
  mainWorktree: string,
  realHome: string,
): void {
  assertNotAncestor(dir, companionsRoot(realHome), "the companions root");
  assertNotAncestor(dir, realHome, "the home directory");
  assertDisjoint(dir, mainWorktree, "the project");
  for (const [otherDir, keys] of keysByCompanionDir(registry, realHome)) {
    const others = keys.filter((k) => k !== key).join(", ");
    if (others === "") continue;
    if (otherDir === dir)
      throw new CliError(`The companion directory ${dir} is already used by ${others}.`);
    assertDisjoint(dir, otherDir, `the companion directory of ${others}`);
  }
}

function assertDisjoint(dir: string, other: string, label: string): void {
  assertNotAncestor(dir, other, label);
  if (isSameOrInside(dir, other)) throw boundsError(dir, "is inside", other, label);
}

function assertNotAncestor(dir: string, other: string, label: string): void {
  if (isSameOrInside(other, dir))
    throw boundsError(dir, dir === other ? "is" : "contains", other, label);
}

function boundsError(dir: string, relation: string, other: string, label: string): CliError {
  return new CliError(`The companion directory ${dir} ${relation} ${other}, ${label}.`);
}

function keysByCompanionDir(registry: Registry, realHome: string): Map<string, string[]> {
  const keysByDir = new Map<string, string[]>();
  for (const [key, project] of Object.entries(registry.projects)) {
    if (project.dir === undefined) continue;
    const dir = companionDir(project.dir, realHome);
    keysByDir.set(dir, [...(keysByDir.get(dir) ?? []), key]);
  }
  return keysByDir;
}

function writeRegistry(registry: Registry, projects: Record<string, RawRegistryProject>): void {
  const { path } = registry;
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  const file: RawRegistryFile = { ...registry.raw, projects };
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
  /** `removeDir` kept the directory: it is outside the companions root. */
  keptOutsideRoot: boolean;
  aligndev: AligndevProjectSettings | null;
}

/**
 * Removes the companion fields, preserving an independent profile selection. With `removeDir`,
 * removes its directory inside the companions root: a non-empty one requires `force`.
 * Fails before any change.
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
  if (entry.project.dir === undefined)
    throw new CliError(`${entry.key} has no companion in ${path}.`);
  const dir = companionDir(entry.project.dir, realHome);
  const companionEntry = { ...entry, dir };
  const entries = pathExists(dir) ? readdirSync(dir) : undefined;
  const root = companionsRoot(realHome);
  if (removeDir) assertNotAncestor(dir, root, "the companions root");
  const deletable = removeDir && isSameOrInside(dir, root);
  if (deletable)
    assertRemovableDir(registry, companionEntry, entries, { force, mainWorktree, realHome });
  const { [entry.key]: _removed, ...projects } = registry.raw.projects;
  const aligndev = entry.project.aligndev ?? null;
  if (aligndev !== null) {
    const { dir: _dir, items: _items, ...remaining } = registry.raw.projects[entry.key];
    projects[entry.key] = remaining;
  }
  writeRegistry(registry, projects);
  const removed = deletable && entries !== undefined;
  if (removed) rmSync(dir, { recursive: true, force: true });
  return {
    registry: path,
    key: entry.key,
    dir,
    empty: entries && entries.length === 0,
    removed,
    keptOutsideRoot: removeDir && !deletable && entries !== undefined,
    aligndev,
  };
}

function assertRemovableDir(
  registry: Registry,
  entry: CompanionEntry,
  entries: string[] | undefined,
  { force, mainWorktree, realHome }: { force: boolean; mainWorktree: string; realHome: string },
): void {
  assertCompanionDirBounds(registry, entry, mainWorktree, realHome);
  const { dir } = entry;
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

export interface NestedCompanionDir {
  dir: string;
  keys: string[];
  outerDir: string;
  outerKeys: string[];
}

/** The companion directories inside another companion directory of the registry. */
export function nestedCompanionDirs(home: string): NestedCompanionDir[] {
  const registry = readRegistry(home);
  if (registry === undefined) return [];
  const dirs = [...keysByCompanionDir(registry, realOrResolved(home))];
  return dirs.flatMap(([dir, keys]) =>
    dirs
      .filter(([outerDir]) => outerDir !== dir && isSameOrInside(dir, outerDir))
      .map(([outerDir, outerKeys]) => ({ dir, keys, outerDir, outerKeys })),
  );
}
