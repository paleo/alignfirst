import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runAlignfirst } from "../alignfirst-cli.js";
import { type PortRange, type ProjectsMarker, readMarker } from "./markers.js";
import { containsRange, rangesOverlap } from "./ports.js";

export interface ProjectInventory {
  root: string;
  directories: ProjectsDirectory[];
  projects: DiscoveredProject[];
  issues: InventoryIssue[];
}

export interface ProjectsDirectory {
  path: string;
  description?: string;
  portRange?: PortRange;
  others: string[];
}

export interface DiscoveredProject {
  name: string;
  path: string;
  directory: string;
  description: ProjectDescription;
  portRange?: PortRange;
  workspaces: string[];
  overlay?: string;
}

export interface ProjectDescription {
  source: "root" | "overlay" | null;
  overlay: ProjectOverlayDescription | null;
  cli: ProjectCliDescription | null;
  config: ProjectConfigView | null;
}

export interface ProjectConfigView {
  ticketPattern?: string;
  plans?: { folder: string };
  portRange?: PortRange;
}

export interface InventoryIssue {
  path: string;
  message: string;
}

interface ProjectOverlayDescription {
  dir: string;
  matchedBy: "remote" | "paths";
}

interface ProjectCliDescription {
  installed: string;
  range: string;
  satisfied: boolean;
}

export interface InventoryContext {
  env: NodeJS.ProcessEnv;
  home: string;
  alignfirstCommand: string[];
}

interface DirectoryCandidate {
  name: string;
  directory: string;
  path: string;
  enclosingRange?: PortRange;
}

interface MainCandidate extends DirectoryCandidate {
  gitDirectory: string;
  project: DiscoveredProject;
}

interface WalkState {
  directories: ProjectsDirectory[];
  candidates: DirectoryCandidate[];
  issues: InventoryIssue[];
}

interface ProjectError {
  error: string;
}

export function buildInventory(
  root: string,
  marker: ProjectsMarker,
  ctx: InventoryContext,
): ProjectInventory {
  const state: WalkState = { directories: [], candidates: [], issues: [] };
  walkProjectsDirectory(root, marker, undefined, state);
  const projects = classifyCandidates(state, ctx);
  projects.sort((left, right) => left.path.localeCompare(right.path));
  reportOverlappingProjects(projects, state.issues);
  reportUnmatchedOverlays(root, projects, state.issues, ctx);
  sortInventory(state.directories, projects, state.issues);
  return { root, directories: state.directories, projects, issues: state.issues };
}

function walkProjectsDirectory(
  path: string,
  marker: ProjectsMarker,
  enclosingRange: PortRange | undefined,
  state: WalkState,
): void {
  const effectiveRange = marker.portRange ?? enclosingRange;
  state.directories.push({
    path,
    ...(marker.description === undefined ? {} : { description: marker.description }),
    ...(marker.portRange === undefined ? {} : { portRange: marker.portRange }),
    others: [],
  });
  for (const candidate of readDirectoryCandidates(path)) {
    const childMarker = readMarker(candidate.path);
    if (childMarker === undefined) {
      state.candidates.push({ ...candidate, enclosingRange: effectiveRange });
      continue;
    }
    reportOutsideRange(candidate.path, childMarker.portRange, effectiveRange, state.issues);
    walkProjectsDirectory(candidate.path, childMarker, effectiveRange, state);
  }
}

function readDirectoryCandidates(directory: string): DirectoryCandidate[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readDirectoryCandidate(directory, entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readDirectoryCandidate(directory: string, name: string): DirectoryCandidate[] {
  try {
    return [{ name, directory, path: realpathSync(join(directory, name)) }];
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  }
}

function classifyCandidates(state: WalkState, ctx: InventoryContext): DiscoveredProject[] {
  const linkedCandidates: DirectoryCandidate[] = [];
  const ordinaryCandidates: DirectoryCandidate[] = [];
  for (const candidate of state.candidates) {
    (isLinkedWorktree(candidate.path) ? linkedCandidates : ordinaryCandidates).push(candidate);
  }
  const projects = ordinaryCandidates.flatMap((candidate) =>
    classifyCandidate(candidate, state, ctx),
  );
  attachLinkedWorktrees(linkedCandidates, projects, state.directories);
  return projects;
}

function classifyCandidate(
  candidate: DirectoryCandidate,
  state: WalkState,
  ctx: InventoryContext,
): DiscoveredProject[] {
  const description = describeProject(ctx.alignfirstCommand, candidate.path, {
    ...ctx.env,
    HOME: ctx.home,
  });
  if ("error" in description) {
    state.issues.push({ path: candidate.path, message: description.error });
    return [];
  }
  if (description.source === null) {
    addOther(state.directories, candidate.directory, candidate.name);
    return [];
  }
  const project: DiscoveredProject = {
    name: candidate.name,
    path: candidate.path,
    directory: candidate.directory,
    description,
    ...(description.config?.portRange === undefined
      ? {}
      : { portRange: description.config.portRange }),
    workspaces: [],
    ...(description.source === "overlay" && description.overlay !== null
      ? { overlay: description.overlay.dir }
      : {}),
  };
  if (description.source === "root" && mainWorktreeGitDirectory(candidate.path) === undefined) {
    state.issues.push({ path: candidate.path, message: "not a git main worktree" });
  }
  reportOutsideRange(project.path, project.portRange, candidate.enclosingRange, state.issues);
  return [project];
}

function describeProject(
  command: string[],
  path: string,
  env: NodeJS.ProcessEnv,
): ProjectDescription | ProjectError {
  const result = runAlignfirst(command, ["config", "--json"], path, env);
  if (result.status !== 0) {
    return { error: firstLine(result.stderr) || "alignfirst config failed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Invalid alignfirst config report for ${path}: ${errorMessage(error)}`);
  }
  return parseProjectDescription(value, path);
}

function parseProjectDescription(value: unknown, path: string): ProjectDescription {
  if (!isRecord(value)) throw invalidDescription(path);
  const source = parseSource(value.source, path);
  return {
    source,
    overlay: parseOverlay(value.overlay, path),
    cli: parseCli(value.cli, path),
    config: parseConfig(value.config, path),
  };
}

function parseSource(value: unknown, path: string): ProjectDescription["source"] {
  if (value === "root" || value === "overlay" || value === null) return value;
  throw invalidDescription(path);
}

function parseOverlay(value: unknown, path: string): ProjectOverlayDescription | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.dir !== "string" ||
    (value.matchedBy !== "remote" && value.matchedBy !== "paths")
  ) {
    throw invalidDescription(path);
  }
  return { dir: value.dir, matchedBy: value.matchedBy };
}

function parseCli(value: unknown, path: string): ProjectCliDescription | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.installed !== "string" ||
    typeof value.range !== "string" ||
    typeof value.satisfied !== "boolean"
  ) {
    throw invalidDescription(path);
  }
  return { installed: value.installed, range: value.range, satisfied: value.satisfied };
}

function parseConfig(value: unknown, path: string): ProjectConfigView | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidDescription(path);
  const ticketPattern = value.ticketPattern;
  const plans = parsePlans(value.plans, path);
  const portRange = value.portRange;
  if (ticketPattern !== undefined && typeof ticketPattern !== "string")
    throw invalidDescription(path);
  if (portRange !== undefined && !isPortRange(portRange)) throw invalidDescription(path);
  return {
    ...(ticketPattern === undefined ? {} : { ticketPattern }),
    ...(plans === undefined ? {} : { plans }),
    ...(portRange === undefined ? {} : { portRange }),
  };
}

function parsePlans(value: unknown, path: string): { folder: string } | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.folder !== "string") throw invalidDescription(path);
  return { folder: value.folder };
}

function invalidDescription(path: string): Error {
  return new Error(`Invalid alignfirst config report for ${path}`);
}

function firstLine(value: string): string {
  return value.trim().split("\n", 1)[0] ?? "";
}

function isLinkedWorktree(path: string): boolean {
  try {
    return lstatSync(join(path, ".git")).isFile();
  } catch {
    return false;
  }
}

function attachLinkedWorktrees(
  candidates: DirectoryCandidate[],
  projects: DiscoveredProject[],
  directories: ProjectsDirectory[],
): void {
  const mainsByGitDirectory = new Map<string, MainCandidate>();
  for (const project of projects) {
    const gitDirectory = mainWorktreeGitDirectory(project.path);
    if (gitDirectory === undefined) continue;
    mainsByGitDirectory.set(gitDirectory, {
      name: project.name,
      directory: project.directory,
      path: project.path,
      gitDirectory,
      project,
    });
  }
  for (const candidate of candidates) {
    const main = linkedWorktreeMain(candidate.path, mainsByGitDirectory);
    if (main === undefined) addOther(directories, candidate.directory, candidate.name);
    else main.project.workspaces.push(candidate.name);
  }
}

function mainWorktreeGitDirectory(projectPath: string): string | undefined {
  const gitPath = join(projectPath, ".git");
  try {
    if (!lstatSync(gitPath).isDirectory()) return;
    return realpathSync(gitPath);
  } catch {
    return;
  }
}

function linkedWorktreeMain(
  worktreePath: string,
  mainsByGitDirectory: ReadonlyMap<string, MainCandidate>,
): MainCandidate | undefined {
  const worktreeGitFile = join(worktreePath, ".git");
  try {
    if (!lstatSync(worktreeGitFile).isFile()) return;
    const metadataDirectory = resolveGitdirFile(worktreeGitFile);
    const mainGitDirectory = resolveMetadataPath(metadataDirectory, "commondir");
    const main = mainsByGitDirectory.get(mainGitDirectory);
    if (main === undefined) return;
    if (dirname(metadataDirectory) !== join(mainGitDirectory, "worktrees")) return;
    const backlink = resolveMetadataPath(metadataDirectory, "gitdir");
    if (backlink !== realpathSync(worktreeGitFile)) return;
    return main;
  } catch {
    return;
  }
}

function resolveGitdirFile(gitFile: string): string {
  const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(gitFile, "utf8"));
  if (match === null) throw new Error(`Invalid Git file: ${gitFile}`);
  return realpathSync(resolve(dirname(gitFile), match[1]));
}

function resolveMetadataPath(metadataDirectory: string, filename: string): string {
  const target = readFileSync(join(metadataDirectory, filename), "utf8").trim();
  if (target.length === 0) throw new Error(`Empty Git metadata file: ${filename}`);
  return realpathSync(resolve(metadataDirectory, target));
}

function addOther(directories: ProjectsDirectory[], directoryPath: string, name: string): void {
  const directory = directories.find(({ path }) => path === directoryPath);
  if (directory === undefined) throw new Error(`Unknown projects directory: ${directoryPath}`);
  directory.others.push(name);
}

function reportOutsideRange(
  path: string,
  range: PortRange | undefined,
  enclosingRange: PortRange | undefined,
  issues: InventoryIssue[],
): void {
  if (range === undefined || enclosingRange === undefined || containsRange(enclosingRange, range)) {
    return;
  }
  issues.push({
    path,
    message: `port range ${formatRange(range)} is outside enclosing range ${formatRange(enclosingRange)}`,
  });
}

function reportOverlappingProjects(projects: DiscoveredProject[], issues: InventoryIssue[]): void {
  const ranged = projects.filter(
    (project): project is DiscoveredProject & { portRange: PortRange } =>
      project.portRange !== undefined,
  );
  for (let index = 0; index < ranged.length; ++index) {
    const project = ranged[index];
    for (let previous = 0; previous < index; ++previous) {
      const other = ranged[previous];
      if (!rangesOverlap(project.portRange, other.portRange)) continue;
      issues.push({
        path: project.path,
        message: `port range ${formatRange(project.portRange)} overlaps ${other.name}`,
      });
    }
  }
}

function reportUnmatchedOverlays(
  root: string,
  projects: DiscoveredProject[],
  issues: InventoryIssue[],
  ctx: InventoryContext,
): void {
  const configured = ctx.env.ALIGNFIRST_OVERLAYS;
  if (configured === undefined || configured === "") return;
  const overlaysRoot = realpathOrUndefined(expandHomePath(configured, ctx.home));
  if (overlaysRoot === undefined) return;
  const matched = new Set(
    projects.flatMap(({ overlay }) => {
      const path = overlay === undefined ? undefined : realpathOrUndefined(overlay);
      return path === undefined ? [] : [path];
    }),
  );
  for (const entry of readdirSync(overlaysRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const overlay = directoryRealpathOrUndefined(join(overlaysRoot, entry.name, "_project"));
    if (overlay === undefined || matched.has(overlay)) continue;
    issues.push({ path: overlay, message: `unmatched overlay: matches no project under ${root}` });
  }
}

function expandHomePath(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return;
  }
}

function directoryRealpathOrUndefined(path: string): string | undefined {
  try {
    if (!lstatSync(path).isDirectory()) return;
    return realpathSync(path);
  } catch {
    return;
  }
}

function sortInventory(
  directories: ProjectsDirectory[],
  projects: DiscoveredProject[],
  issues: InventoryIssue[],
): void {
  directories.sort((left, right) => left.path.localeCompare(right.path));
  projects.sort((left, right) => left.path.localeCompare(right.path));
  issues.sort((left, right) => left.path.localeCompare(right.path));
  for (const directory of directories)
    directory.others.sort((left, right) => left.localeCompare(right));
  for (const project of projects)
    project.workspaces.sort((left, right) => left.localeCompare(right));
}

function formatRange(range: PortRange): string {
  return `${range.first}..${range.last}`;
}

function isPortRange(value: unknown): value is PortRange {
  return isRecord(value) && typeof value.first === "number" && typeof value.last === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
