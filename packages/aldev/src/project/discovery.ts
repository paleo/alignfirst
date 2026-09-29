import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { isNodeError } from "../errors.js";
import { formatRange } from "./format.js";
import { type ProjectReport, readProjectReport } from "./layout.js";
import {
  containsRange,
  type MarkerPortRange,
  type PortRange,
  type ProjectsMarker,
  rangesOverlap,
  readMarker,
} from "./markers.js";

const PROJECT_CONFIG_FILENAME = ".alignfirst.json";

export interface ProjectInventory {
  root: string;
  directories: ProjectsDirectory[];
  projects: DiscoveredProject[];
  issues: InventoryIssue[];
}

export interface ProjectsDirectory {
  path: string;
  description?: string;
  portRanges?: MarkerPortRange[];
  others: string[];
}

export interface DiscoveredProject {
  name: string;
  path: string;
  directory: string;
  description: ProjectReport;
  portRange?: PortRange;
  portRangeCode?: string;
  workspaces: string[];
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

export interface InventoryContext {
  env: NodeJS.ProcessEnv;
  alignfirstCommand: string[];
}

interface DirectoryCandidate {
  name: string;
  directory: string;
  path: string;
  enclosingRanges?: MarkerPortRange[];
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

export function buildInventory(
  root: string,
  marker: ProjectsMarker,
  ctx: InventoryContext,
): ProjectInventory {
  const state: WalkState = { directories: [], candidates: [], directoryClaims: [], issues: [] };
  walkProjectsDirectory(root, marker, undefined, state);
  const projects = classifyCandidates(state, ctx);
  reportSharedCompanions(projects, state.issues);
  reportOverlappingClaims(projects, state.directoryClaims, state.issues);
  sortInventory(state.directories, projects, state.issues);
  return { root, directories: state.directories, projects, issues: state.issues };
}

function walkProjectsDirectory(
  path: string,
  marker: ProjectsMarker,
  enclosingRanges: MarkerPortRange[] | undefined,
  state: WalkState,
): void {
  const effectiveRanges = marker.portRanges ?? enclosingRanges;
  state.directories.push({
    path,
    ...(marker.description === undefined ? {} : { description: marker.description }),
    ...(marker.portRanges === undefined ? {} : { portRanges: marker.portRanges }),
    others: [],
  });
  for (const candidate of readDirectoryCandidates(path)) {
    const childMarker = readMarker(candidate.path);
    if (childMarker === undefined) {
      state.candidates.push({ ...candidate, enclosingRanges: effectiveRanges });
      continue;
    }
    for (const portRange of childMarker.portRanges ?? []) {
      reportOutsideRange(candidate.path, portRange, effectiveRanges, state.issues);
      state.directoryClaims.push({
        scope: path,
        path: candidate.path,
        portRange,
      });
    }
    walkProjectsDirectory(candidate.path, childMarker, effectiveRanges, state);
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
  if (mainWorktreeGitDirectory(candidate.path) === undefined) {
    if (existsSync(join(candidate.path, PROJECT_CONFIG_FILENAME))) {
      state.issues.push({ path: candidate.path, message: "not a git main worktree" });
    } else {
      addOther(state.directories, candidate.directory, candidate.name);
    }
    return [];
  }
  const description = readProjectReport(ctx.alignfirstCommand, candidate.path, ctx.env);
  if ("error" in description) {
    state.issues.push({ path: candidate.path, message: description.error });
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
  const enclosingRange = findEnclosingRange(candidate.enclosingRanges, project.portRange);
  if (enclosingRange?.code !== undefined) project.portRangeCode = enclosingRange.code;
  if (description.cli !== null && !description.cli.satisfied) {
    state.issues.push({
      path: candidate.path,
      message:
        `AlignFirst CLI ${description.cli.installed} does not satisfy required range ` +
        description.cli.range,
    });
  }
  reportOutsideRange(project.path, project.portRange, candidate.enclosingRanges, state.issues);
  return [project];
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
  enclosingRanges: MarkerPortRange[] | undefined,
  issues: InventoryIssue[],
): void {
  if (range === undefined || enclosingRanges === undefined) return;
  if (findEnclosingRange(enclosingRanges, range) !== undefined) return;
  issues.push({
    path,
    message:
      `port range ${formatRange(range)} fits no single enclosing range: ` +
      enclosingRanges.map(formatRange).join(", "),
  });
}

function findEnclosingRange(
  ranges: MarkerPortRange[] | undefined,
  claim: PortRange | undefined,
): MarkerPortRange | undefined {
  if (claim === undefined) return;
  return ranges?.find((range) => containsRange(range, claim));
}

// Two projects can share a companion only through a `_` in a directory name.
function reportSharedCompanions(projects: DiscoveredProject[], issues: InventoryIssue[]): void {
  const projectsByCompanion = new Map<string, DiscoveredProject[]>();
  for (const project of projects) {
    const dir = project.description.companion?.dir;
    if (dir === undefined) continue;
    projectsByCompanion.set(dir, [...(projectsByCompanion.get(dir) ?? []), project]);
  }
  for (const [dir, group] of projectsByCompanion) {
    if (group.length < 2) continue;
    for (const project of group) {
      const others = group
        .filter((other) => other !== project)
        .map((other) => other.path)
        .toSorted();
      issues.push({
        path: project.path,
        message: `shares companion directory ${dir} with ${others.join(", ")}`,
      });
    }
  }
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
