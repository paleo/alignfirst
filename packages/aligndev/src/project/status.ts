import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

import { readWorktrees } from "@alignfirst/workspace/git";
import type { DiscoveredProject, ProjectInventory } from "./discovery.js";
import { errorMessage, isNodeError } from "../errors.js";
import type {
  AligndevProjectSettings,
  CompanionReport,
  ConfigSource,
  ItemLocation,
  ItemName,
} from "./layout.js";
import type { PortRange } from "./markers.js";

const URL_WITH_AUTHORITY = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u;

export interface ProjectDetails {
  name: string;
  path: string;
  directory: string;
  remoteHost: string | null;
  portRange: PortRange | null;
  portRangeCode: string | null;
  plansFolder: string | null;
  ticketIdPattern: string | null;
  configSource: ConfigSource | null;
  companion: CompanionReport | null;
  aligndev: AligndevProjectSettings | null;
  locations: Record<ItemName, ItemLocation>;
  workspaces: string[];
  worktrees: ProjectWorktree[];
}

export interface ProjectWorktree {
  branch: string | null;
  name: string;
  path: string;
}

export function getProjectStatus(inventory: ProjectInventory, projectPath: string): ProjectDetails {
  const path = realPathOrSelf(projectPath);
  const project = inventory.projects.find((candidate) => candidate.path === path);
  if (project === undefined) {
    throw new Error(
      `${path} is not a project of ${inventory.root}. Pass the main-worktree path of a git ` +
        "repository in that projects directory.",
    );
  }
  return buildProjectDetails(project);
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return path;
    throw error;
  }
}

function buildProjectDetails(project: DiscoveredProject): ProjectDetails {
  return {
    name: project.name,
    path: project.path,
    directory: project.directory,
    remoteHost: readRemoteHost(project.path),
    portRange: project.portRange ?? null,
    portRangeCode: project.portRangeCode ?? null,
    plansFolder: project.description.config?.plans?.repositoryFolder ?? null,
    ticketIdPattern: project.description.config?.ticketIdPattern ?? null,
    configSource: project.description.source,
    companion: project.description.companion,
    aligndev: project.description.aligndev,
    locations: project.description.locations,
    workspaces: project.workspaces,
    worktrees: readWorktrees({ cwd: project.path, env: process.env }, project.path).map((tree) => ({
      branch: tree.branch,
      name: basename(tree.path),
      path: tree.path,
    })),
  };
}

function readRemoteHost(projectPath: string): string | null {
  const remotes = runGit(projectPath, "remote")
    .trimEnd()
    .split("\n")
    .filter((remote) => remote.length > 0)
    .toSorted();
  const orderedRemotes = remotes.includes("origin")
    ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
    : remotes;
  for (const remote of orderedRemotes) {
    const host = remoteHost(runGit(projectPath, "remote", "get-url", "--", remote).trim());
    if (host !== null) return host;
  }
  return null;
}

function remoteHost(remoteUrl: string): string | null {
  return URL_WITH_AUTHORITY.test(remoteUrl) ? urlRemoteHost(remoteUrl) : scpRemoteHost(remoteUrl);
}

function urlRemoteHost(remoteUrl: string): string | null {
  try {
    const host = new URL(remoteUrl).hostname;
    return host.length === 0 ? null : host;
  } catch {
    return null;
  }
}

function scpRemoteHost(remoteUrl: string): string | null {
  if (/^[A-Za-z]:[\\/]/u.test(remoteUrl)) return null;
  const match = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):/u.exec(remoteUrl);
  return match?.[1] ?? null;
}

function runGit(projectPath: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Cannot inspect Git project ${projectPath}: ${errorMessage(error)}`);
  }
}
