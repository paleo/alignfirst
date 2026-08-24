import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { AlprojectConfig } from "./config.js";
import { isNodeError } from "./errors.js";
import type { PortAllocation, Registry } from "./registry.js";

export interface ProjectList {
  projects: ListedProject[];
  additionalDirectories: AdditionalDirectoryGroup[];
}

export interface ListedProject {
  name: string;
  parent: string;
  path: string;
  status: ProjectStatus;
  workspaces: string[];
  ports?: ListedPortAllocation;
}

export type ProjectStatus = "registered" | "unregistered" | "missing";

export interface ListedPortAllocation extends PortAllocation {
  endPort: number;
}

export interface ProjectDiscovery {
  projects: DiscoveredProject[];
  additionalDirectories: AdditionalDirectoryGroup[];
}

export interface DiscoveredProject {
  name: string;
  parent: string;
  path: string;
  workspaces: string[];
}

export interface AdditionalDirectoryGroup {
  parent: string;
  directories: string[];
}

interface DirectoryCandidate {
  name: string;
  parent: string;
  path: string;
}

interface MainCandidate extends DirectoryCandidate {
  gitDirectory: string;
}

export function buildProjectList(
  config: Pick<AlprojectConfig, "projectParents">,
  registry: Registry,
): ProjectList {
  const discovery = discoverProjects(config);
  const registeredByPath = new Map(registry.projects.map((project) => [project.path, project]));
  const projects: ListedProject[] = discovery.projects.map((project) => {
    const registered = registeredByPath.get(project.path);
    registeredByPath.delete(project.path);
    return {
      ...project,
      status: registered === undefined ? "unregistered" : "registered",
      ...(registered?.ports === undefined ? {} : { ports: listedPorts(registered.ports) }),
    };
  });

  for (const registered of registeredByPath.values()) {
    projects.push({
      name: basename(registered.path),
      parent: dirname(registered.path),
      path: registered.path,
      status: "missing",
      workspaces: [],
      ...(registered.ports === undefined ? {} : { ports: listedPorts(registered.ports) }),
    });
  }

  projects.sort(compareProjects);
  return { additionalDirectories: discovery.additionalDirectories, projects };
}

export function discoverProjects(
  config: Pick<AlprojectConfig, "projectParents">,
): ProjectDiscovery {
  const candidates = config.projectParents
    .map((parent) => parent.path)
    .toSorted()
    .flatMap(readDirectoryCandidates);
  const mainCandidates = candidates.flatMap((candidate) => {
    const gitDirectory = mainWorktreeGitDirectory(candidate.path);
    return gitDirectory === undefined ? [] : [{ ...candidate, gitDirectory }];
  });
  const mainsByGitDirectory = new Map(
    mainCandidates.map((candidate) => [candidate.gitDirectory, candidate]),
  );
  const workspaceNamesByMainPath = new Map<string, string[]>();
  const classifiedPaths = new Set(mainCandidates.map((candidate) => candidate.path));

  for (const candidate of candidates) {
    if (classifiedPaths.has(candidate.path)) continue;
    const main = linkedWorktreeMain(candidate.path, mainsByGitDirectory);
    if (main === undefined) continue;
    const workspaceNames = workspaceNamesByMainPath.get(main.path) ?? [];
    workspaceNames.push(candidate.name);
    workspaceNamesByMainPath.set(main.path, workspaceNames);
    classifiedPaths.add(candidate.path);
  }

  const projects = mainCandidates
    .map(({ gitDirectory: _gitDirectory, ...main }) => ({
      ...main,
      workspaces: (workspaceNamesByMainPath.get(main.path) ?? []).toSorted(),
    }))
    .toSorted(compareProjects);
  const additionalDirectories = groupAdditionalDirectories(candidates, classifiedPaths);
  return { additionalDirectories, projects };
}

function readDirectoryCandidates(parent: string): DirectoryCandidate[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readDirectoryCandidate(parent, entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readDirectoryCandidate(parent: string, name: string): DirectoryCandidate[] {
  try {
    return [{ name, parent, path: realpathSync(join(parent, name)) }];
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  }
}

export function mainWorktreeGitDirectory(projectPath: string): string | undefined {
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

function groupAdditionalDirectories(
  candidates: readonly DirectoryCandidate[],
  classifiedPaths: ReadonlySet<string>,
): AdditionalDirectoryGroup[] {
  const directoriesByParent = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (classifiedPaths.has(candidate.path)) continue;
    const directories = directoriesByParent.get(candidate.parent) ?? [];
    directories.push(candidate.name);
    directoriesByParent.set(candidate.parent, directories);
  }
  return [...directoriesByParent]
    .map(([parent, directories]) => ({ parent, directories: directories.toSorted() }))
    .toSorted((left, right) => left.parent.localeCompare(right.parent));
}

function listedPorts(ports: PortAllocation): ListedPortAllocation {
  return {
    ...ports,
    endPort: ports.basePort + ports.portsPerWorkspace * ports.maxWorkspaces - 1,
  };
}

function compareProjects(
  left: Pick<DiscoveredProject, "parent" | "path">,
  right: Pick<DiscoveredProject, "parent" | "path">,
): number {
  return left.parent.localeCompare(right.parent) || left.path.localeCompare(right.path);
}
