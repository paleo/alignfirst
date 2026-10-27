import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

import { canonicalPath } from "./git.js";
import { ConfigError } from "./errors.js";

export interface WorkspaceStorage {
  in: "project" | "companion";
  mainWorktree: string;
  currentWorktree: string;
  registryDir: string;
  runtimeDir: string;
  companionDir?: string;
}

export interface WorkspaceStorageSelection {
  in: "project" | "companion";
  mainWorktree: string;
  companionDir?: string;
}

/** Resolves addresses only; ownership and persistence belong to the storage lifecycle. */
export function resolveWorkspaceStorage(
  selection: WorkspaceStorageSelection,
  target: string,
): WorkspaceStorage {
  const mainWorktree = canonicalPath(selection.mainWorktree);
  const currentWorktree = canonicalPath(target);
  const companionDir =
    selection.companionDir === undefined ? undefined : canonicalPath(selection.companionDir);
  const base = selection.in === "companion" ? companionDir : mainWorktree;
  if (base === undefined)
    throw new ConfigError("Companion runtime storage requires a companion directory.");
  const runtimeDir =
    selection.in === "project"
      ? join(currentWorktree, ".local-wt")
      : join(base, ".local-wt", "worktrees", worktreeId(currentWorktree));
  return {
    in: selection.in,
    mainWorktree,
    currentWorktree,
    registryDir: join(base, ".local-wt", "workspace-registry"),
    runtimeDir,
    ...(companionDir === undefined ? {} : { companionDir }),
  };
}

export interface RuntimePathInput {
  runtimeDir: string;
  storage?: WorkspaceStorage;
}

/** Resolve the selected target, not the command's caller, for every log/progress path. */
export function runtimeDirForTarget(config: RuntimePathInput, target: string): string {
  return config.storage === undefined
    ? resolve(canonicalPath(target), config.runtimeDir)
    : resolveWorkspaceStorage(config.storage, target).runtimeDir;
}

function worktreeId(path: string): string {
  const readable = basename(path)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  const name = readable.length === 0 ? "worktree" : readable;
  return `${name}-${createHash("sha256").update(path).digest("hex")}`;
}
