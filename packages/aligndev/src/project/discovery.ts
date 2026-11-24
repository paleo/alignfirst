import {
  type Dirent,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { isNodeError } from "../errors.js";
import { formatRange } from "./format.js";
import { type ProjectReport, readProjectReport } from "./layout.js";
import { containsRange, type PortRange, rangesOverlap } from "./ports.js";

const CONFIG_FILENAMES = ["alignfirst.json", "alignfirst.jsonc"];
const PERMISSION_ERRORS = ["EACCES", "EPERM"];

export interface ProjectInventory {
  root: string;
  portRange: PortRange | null;
  projects: DiscoveredProject[];
  skippedDirectories: SkippedDirectory[];
  issues: InventoryIssue[];
}

export interface DiscoveredProject {
  name: string;
  path: string;
  // The parent directory of the project.
  directory: string;
  description: ProjectReport;
  portRange?: PortRange;
  workspaces: string[];
}

export interface SkippedDirectory {
  path: string;
  reason: "outsideWorktree" | "workFilesRepository" | "symlink" | "unreadable" | "maxDepth";
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

export interface ScanOptions {
  portRange?: PortRange;
  maxDepth: number;
}

export interface InventoryContext {
  env: NodeJS.ProcessEnv;
  alignfirstCommand: string[];
}

interface DirectoryCandidate {
  name: string;
  directory: string;
  path: string;
}

interface ScanState {
  maxDepth: number;
  mainCandidates: DirectoryCandidate[];
  linkedCandidates: DirectoryCandidate[];
  skippedDirectories: SkippedDirectory[];
  issues: InventoryIssue[];
}

export function buildInventory(
  root: string,
  options: ScanOptions,
  ctx: InventoryContext,
): ProjectInventory {
  const state: ScanState = {
    maxDepth: options.maxDepth,
    mainCandidates: [],
    linkedCandidates: [],
    skippedDirectories: [],
    issues: [],
  };
  scanEntries(root, readGroupEntries(root), 1, state);
  const projects = classifyCandidates(state, ctx);
  reportSharedCompanions(projects, state.issues);
  reportOverlappingClaims(projects, state.issues);
  if (options.portRange !== undefined)
    reportOutsideRange(projects, options.portRange, state.issues);
  sortInventory(projects, state);
  return {
    root,
    portRange: options.portRange ?? null,
    projects,
    skippedDirectories: state.skippedDirectories,
    issues: state.issues,
  };
}

function readGroupEntries(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
  );
}

function scanEntries(directory: string, entries: Dirent[], depth: number, state: ScanState): void {
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (isDirectoryTarget(path)) state.skippedDirectories.push({ path, reason: "symlink" });
    } else if (entry.isDirectory()) {
      scanDirectory({ name: entry.name, directory, path }, depth, state);
    }
  }
}

function isDirectoryTarget(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A `.git` directory marks a main worktree, a `.git` file a linked one; anything else is a group.
function scanDirectory(candidate: DirectoryCandidate, depth: number, state: ScanState): void {
  const git = readGitEntry(candidate.path);
  if (git === "unreadable") {
    state.skippedDirectories.push({ path: candidate.path, reason: "unreadable" });
  } else if (git?.isDirectory()) {
    state.mainCandidates.push(candidate);
  } else if (git?.isFile()) {
    state.linkedCandidates.push(candidate);
  } else {
    scanGroup(candidate.path, depth, state);
  }
}

function readGitEntry(path: string): Stats | "unreadable" | undefined {
  try {
    return lstatSync(join(path, ".git"), { throwIfNoEntry: false });
  } catch (error) {
    if (isPermissionError(error)) return "unreadable";
    throw error;
  }
}

function scanGroup(path: string, depth: number, state: ScanState): void {
  let entries: Dirent[];
  try {
    entries = readGroupEntries(path);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    state.skippedDirectories.push({ path, reason: "unreadable" });
    return;
  }
  if (entries.some((entry) => CONFIG_FILENAMES.includes(entry.name))) {
    state.issues.push({ path, message: "not a git main worktree" });
  }
  if (depth >= state.maxDepth) {
    state.skippedDirectories.push({ path, reason: "maxDepth" });
    return;
  }
  scanEntries(path, entries, depth + 1, state);
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && error.code !== undefined && PERMISSION_ERRORS.includes(error.code);
}

function classifyCandidates(state: ScanState, ctx: InventoryContext): DiscoveredProject[] {
  const classified = state.mainCandidates.flatMap((candidate) =>
    classifyCandidate(candidate, state.issues, ctx),
  );
  const projects = excludeWorkFilesRepositories(classified, state.skippedDirectories);
  attachLinkedWorktrees(state.linkedCandidates, projects, state.skippedDirectories);
  return projects;
}

function classifyCandidate(
  candidate: DirectoryCandidate,
  issues: InventoryIssue[],
  ctx: InventoryContext,
): DiscoveredProject[] {
  const description = readProjectReport(ctx.alignfirstCommand, candidate.path, ctx.env);
  if ("error" in description) {
    issues.push({ path: candidate.path, message: description.error });
    return [];
  }
  return [
    {
      name: candidate.name,
      path: candidate.path,
      directory: candidate.directory,
      description,
      ...(description.workspace.portRange === null
        ? {}
        : { portRange: description.workspace.portRange }),
      workspaces: [],
    },
  ];
}

// A repository holding another project's `.plans` target, such as a work-files clone, is skipped.
function excludeWorkFilesRepositories(
  projects: DiscoveredProject[],
  skippedDirectories: SkippedDirectory[],
): DiscoveredProject[] {
  const plansTargets = projects.flatMap((project) => {
    const target = realPlansPath(project);
    return target === undefined ? [] : [{ owner: project.path, target }];
  });
  return projects.filter((project) => {
    const holdsPlans = plansTargets.some(
      ({ owner, target }) => owner !== project.path && isSameOrInside(target, project.path),
    );
    if (holdsPlans) skippedDirectories.push({ path: project.path, reason: "workFilesRepository" });
    return !holdsPlans;
  });
}

function realPlansPath(project: DiscoveredProject): string | undefined {
  const plans = project.description.locations[".plans"];
  if (!plans.exists) return;
  try {
    return realpathSync(plans.path);
  } catch {
    return;
  }
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}${sep}`);
}

function attachLinkedWorktrees(
  candidates: DirectoryCandidate[],
  projects: DiscoveredProject[],
  skippedDirectories: SkippedDirectory[],
): void {
  const mainsByGitDirectory = new Map<string, DiscoveredProject>();
  for (const project of projects) {
    const gitDirectory = mainWorktreeGitDirectory(project.path);
    if (gitDirectory !== undefined) mainsByGitDirectory.set(gitDirectory, project);
  }
  for (const candidate of candidates) {
    const main = linkedWorktreeMain(candidate.path, mainsByGitDirectory);
    if (main === undefined) {
      skippedDirectories.push({ path: candidate.path, reason: "outsideWorktree" });
    } else {
      main.workspaces.push(candidate.name);
    }
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
  mainsByGitDirectory: ReadonlyMap<string, DiscoveredProject>,
): DiscoveredProject | undefined {
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

// Two projects share a companion only when their registry `dir` values resolve to the same path.
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

function reportOverlappingClaims(projects: DiscoveredProject[], issues: InventoryIssue[]): void {
  const claims = projects
    .flatMap((project): ProjectPortClaim[] =>
      project.portRange === undefined ? [] : [{ path: project.path, portRange: project.portRange }],
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  for (let index = 0; index < claims.length; ++index) {
    const claim = claims[index];
    for (let previous = 0; previous < index; ++previous) {
      const other = claims[previous];
      if (!rangesOverlap(claim.portRange, other.portRange)) continue;
      issues.push({
        path: claim.path,
        message: `port range ${formatRange(claim.portRange)} overlaps ${other.path}`,
        conflict: { left: other, right: claim },
      });
    }
  }
}

function reportOutsideRange(
  projects: DiscoveredProject[],
  available: PortRange,
  issues: InventoryIssue[],
): void {
  for (const { path, portRange } of projects) {
    if (portRange === undefined || containsRange(available, portRange)) continue;
    issues.push({
      path,
      message:
        `port range ${formatRange(portRange)} is outside portRange ` +
        `${formatRange(available)} in the aligndev config`,
    });
  }
}

function sortInventory(projects: DiscoveredProject[], state: ScanState): void {
  projects.sort((left, right) => left.path.localeCompare(right.path));
  state.skippedDirectories.sort((left, right) => left.path.localeCompare(right.path));
  state.issues.sort((left, right) => left.path.localeCompare(right.path));
  for (const project of projects)
    project.workspaces.sort((left, right) => left.localeCompare(right));
}
