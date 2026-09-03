import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import type { DiscoveredProject, ProjectInventory } from "./discovery.js";
import type { PortRange } from "./markers.js";

const URL_WITH_AUTHORITY = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u;

export interface ProjectDetails {
  name: string;
  path: string;
  directory: string;
  remoteHost: string | null;
  configSource: string;
  portRange: PortRange | null;
  plansFolder: string | null;
  ticketPattern: string | null;
  workspaces: string[];
  worktrees: ProjectWorktree[];
}

export interface ProjectWorktree {
  branch: string | null;
  name: string;
  path: string;
}

export function getProjectStatus(inventory: ProjectInventory, inputPath: string): ProjectDetails {
  const path = resolveProjectPath(inventory.root, inputPath);
  const project = inventory.projects.find((candidate) => candidate.path === path);
  if (project === undefined) {
    throw new Error(
      `${path} is not a project of ${inventory.root}. Pass the main-worktree path of a project ` +
        "holding .alignfirst.json or matching an overlay.",
    );
  }
  return buildProjectDetails(project);
}

function resolveProjectPath(root: string, inputPath: string): string {
  const path = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
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
    configSource: project.description.source === "root" ? "root" : (project.overlay ?? "root"),
    portRange: project.portRange ?? null,
    plansFolder: project.description.config?.plans?.folder ?? null,
    ticketPattern: project.description.config?.ticketPattern ?? null,
    workspaces: project.workspaces,
    worktrees: readWorktrees(project.path),
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

function readWorktrees(projectPath: string): ProjectWorktree[] {
  return runGit(projectPath, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter((record) => record.length > 0)
    .map(parseWorktree);
}

function parseWorktree(record: string): ProjectWorktree {
  const fields = record.split("\0");
  const pathField = fields.find((field) => field.startsWith("worktree "));
  if (pathField === undefined) throw new Error("Git returned a worktree record without a path");
  const path = realpathSync(pathField.slice("worktree ".length));
  const branchField = fields.find((field) => field.startsWith("branch "));
  return {
    branch: branchField === undefined ? null : shortBranch(branchField.slice("branch ".length)),
    name: basename(path),
    path,
  };
}

function shortBranch(branch: string): string {
  const prefix = "refs/heads/";
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
