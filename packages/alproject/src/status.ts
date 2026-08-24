import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import type { AlprojectConfig } from "./config.js";
import { buildProjectList, type ListedPortAllocation, type ProjectStatus } from "./discovery.js";
import { AlprojectError, errorMessage } from "./errors.js";
import { canonicalizePath, resolveProjectPath } from "./paths.js";
import type { Registry } from "./registry.js";

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
  const project = buildProjectList(config, registry).projects.find(
    (candidate) => candidate.path === path,
  );
  if (project === undefined) {
    throw new AlprojectError(
      "filesystem",
      `Project is neither registered nor discovered: ${path}. Use the canonical main-worktree path.`,
    );
  }
  if (project.status === "missing") {
    return {
      name: project.name,
      path: project.path,
      ports: project.ports ?? null,
      remoteHost: null,
      status: project.status,
      worktrees: [],
    };
  }
  return {
    name: project.name,
    path: project.path,
    ports: project.ports ?? null,
    remoteHost: readRemoteHost(project.path),
    status: project.status,
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
  return urlRemoteHost(remoteUrl) ?? scpRemoteHost(remoteUrl);
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
