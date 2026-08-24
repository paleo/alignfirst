import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { AlprojectConfig } from "./config.js";
import {
  type ListedPortAllocation,
  mainWorktreeGitDirectory,
  type ProjectStatus,
} from "./discovery.js";
import { AlprojectError, errorMessage, isNodeError } from "./errors.js";
import { canonicalizePath, resolveProjectPath } from "./paths.js";
import { allocationEnd } from "./ports.js";
import type { PortAllocation, Registry } from "./registry.js";

const URL_WITH_AUTHORITY = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u;

export interface ProjectDetails {
  name: string;
  path: string;
  ports: ListedPortAllocation | null;
  remoteHost: string | null;
  status: ProjectStatus;
  worktrees: ProjectWorktree[];
}

export interface ProjectWorktree {
  branch: string | null;
  name: string;
  path: string;
}

export function getProjectStatus(
  config: AlprojectConfig,
  registry: Registry,
  inputPath: string,
): ProjectDetails {
  const path = resolveProjectPath(inputPath, config.root.path);
  const registration = registry.projects.find((candidate) => candidate.path === path);
  if (registration !== undefined && isMissingPath(path)) {
    return {
      name: basename(path),
      path,
      ports: listedPorts(registration.ports),
      remoteHost: null,
      status: "missing",
      worktrees: [],
    };
  }
  if (mainWorktreeGitDirectory(path) === undefined) {
    throw projectLookupError(path, registration !== undefined);
  }
  if (
    registration === undefined &&
    !config.projectParents.some((parent) => parent.path === dirname(path))
  ) {
    throw projectLookupError(path, false);
  }
  return {
    name: basename(path),
    path,
    ports: listedPorts(registration?.ports),
    remoteHost: readRemoteHost(path),
    status: registration === undefined ? "unregistered" : "registered",
    worktrees: readWorktrees(path),
  };
}

function isMissingPath(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return true;
    throw new AlprojectError(
      "filesystem",
      `Cannot inspect project path ${path}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function listedPorts(ports: PortAllocation | undefined): ListedPortAllocation | null {
  return ports === undefined ? null : { ...ports, endPort: allocationEnd(ports) };
}

function projectLookupError(path: string, registered: boolean): AlprojectError {
  const detail = registered
    ? `Registered project is not a Git main worktree: ${path}. Use the canonical main-worktree path.`
    : `Project is neither registered nor discovered: ${path}. Use the canonical main-worktree path.`;
  return new AlprojectError("filesystem", detail);
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
  if (pathField === undefined) {
    throw new AlprojectError("filesystem", "Git returned a worktree record without a path");
  }
  const path = canonicalizePath(pathField.slice("worktree ".length));
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
    throw new AlprojectError(
      "filesystem",
      `Cannot inspect Git project ${projectPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
