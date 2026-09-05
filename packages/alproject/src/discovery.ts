import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { runAlignfirst } from "./alignfirst-cli.js";
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
}

export interface ProjectDescription {
  source: "root" | null;
  cli: ProjectCliDescription | null;
  config: ProjectConfigView | null;
}

export interface ProjectConfigView {
  ticketIdPattern?: string;
  plans?: { folder?: string };
  portRange?: PortRange;
}

export interface InventoryIssue {
  path: string;
  message: string;
  conflict?: PortConflict;
}

export interface PortConflict {
  left: ProjectPortClaim;
  right: ProjectPortClaim;
}

interface ProjectPortClaim {
  path: string;
  portRange: PortRange;
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
  directoryClaims: ScopedPortClaim[];
  issues: InventoryIssue[];
}

interface ScopedPortClaim extends ProjectPortClaim {
  scope: string;
}

interface ProjectError {
  error: string;
}

export function buildInventory(
  root: string,
  marker: ProjectsMarker,
  ctx: InventoryContext,
): ProjectInventory {
  const state: WalkState = { directories: [], candidates: [], directoryClaims: [], issues: [] };
  walkProjectsDirectory(root, marker, undefined, state);
  const projects = classifyCandidates(state, ctx);
  reportOverlappingClaims(projects, state.directoryClaims, state.issues);
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
    if (childMarker.portRange !== undefined) {
      state.directoryClaims.push({
        scope: path,
        path: candidate.path,
        portRange: childMarker.portRange,
      });
    }
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
  };
  if (mainWorktreeGitDirectory(candidate.path) === undefined) {
    state.issues.push({ path: candidate.path, message: "not a git main worktree" });
  }
  if (description.cli !== null && !description.cli.satisfied) {
    state.issues.push({
      path: candidate.path,
      message:
        `AlignFirst CLI ${description.cli.installed} does not satisfy required range ` +
        description.cli.range,
    });
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
    cli: parseCli(value.cli, path),
    config: parseConfig(value.config, path),
  };
}

function parseSource(value: unknown, path: string): ProjectDescription["source"] {
  if (value === "root" || value === null) return value;
  throw invalidDescription(path);
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
  const ticketIdPattern = value.ticketIdPattern;
  const plans = parsePlans(value.plans, path);
  const portRange = value.portRange;
  if (ticketIdPattern !== undefined && typeof ticketIdPattern !== "string")
    throw invalidDescription(path);
  if (portRange !== undefined && !isPortRange(portRange)) throw invalidDescription(path);
  return {
    ...(ticketIdPattern === undefined ? {} : { ticketIdPattern }),
    ...(plans === undefined ? {} : { plans }),
    ...(portRange === undefined ? {} : { portRange }),
  };
}

function parsePlans(value: unknown, path: string): { folder?: string } | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidDescription(path);
  if (value.folder !== undefined && typeof value.folder !== "string")
    throw invalidDescription(path);
  return value.folder === undefined ? {} : { folder: value.folder };
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

function reportOverlappingClaims(
  projects: DiscoveredProject[],
  directoryClaims: ScopedPortClaim[],
  issues: InventoryIssue[],
): void {
  const claims = [
    ...directoryClaims,
    ...projects.flatMap((project): ScopedPortClaim[] =>
      project.portRange === undefined
        ? []
        : [{ scope: project.directory, path: project.path, portRange: project.portRange }],
    ),
  ].toSorted(
    (left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path),
  );
  for (let index = 0; index < claims.length; ++index) {
    const claim = claims[index];
    for (let previous = 0; previous < index; ++previous) {
      const other = claims[previous];
      if (claim.scope !== other.scope || !rangesOverlap(claim.portRange, other.portRange)) continue;
      issues.push({
        path: claim.path,
        message: `port range ${formatRange(claim.portRange)} overlaps ${basename(other.path)}`,
        conflict: {
          left: { path: other.path, portRange: other.portRange },
          right: { path: claim.path, portRange: claim.portRange },
        },
      });
    }
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
