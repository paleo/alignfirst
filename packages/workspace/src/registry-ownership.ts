import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";
import { canonicalPath } from "./git.js";

export interface RegistryOwner {
  in: "project" | "companion";
  mainWorktree: string;
  registryDir: string;
}

/** Absolute addressing is independent of the main identity used to authorize it. */
export function registryOwner(mainWorktree: string, registryDir: string): RegistryOwner {
  const main = canonicalPath(mainWorktree);
  const directory = resolve(main, registryDir);
  const placement = isWithin(main, directory) ? "project" : "companion";
  if (
    placement === "companion" &&
    directory !== join(dirname(dirname(directory)), ".local-wt", "workspace-registry")
  )
    throw new WorkspaceError(
      `Invalid companion registry layout: ${directory}. Use the resolved selected storage destination.`,
    );
  return {
    in: placement,
    mainWorktree: main,
    registryDir: directory,
  };
}

export function assertRegistryOwnership(
  mainWorktree: string,
  currentWorktree: string,
  registryDir: string,
): void {
  const owner = registryOwner(mainWorktree, registryDir);
  assertSelectedRegistry(mainWorktree, owner.registryDir);
  if (owner.in === "companion" || canonicalPath(mainWorktree) === canonicalPath(currentWorktree))
    return;
  const currentRegistry = resolve(currentWorktree, relative(mainWorktree, owner.registryDir));
  assertDirectoryPath(canonicalPath(currentWorktree), dirname(currentRegistry));
  const entry = lstatSync(currentRegistry, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isSymbolicLink()) {
    try {
      if (realpathSync(currentRegistry) === realpathSync(owner.registryDir)) return;
    } catch {
      /* Broken links cannot establish registry ownership. */
    }
  }
  throw new WorkspaceError(
    `Linked registry must link to its own main worktree registry: ${currentRegistry}. ` +
      "Existing state was preserved; repair the registry link before retrying.",
  );
}

/** Validate the owner before interpreting any sidecar, including startup claims. */
export function assertSelectedRegistry(mainWorktree: string, registryDir: string): void {
  const expected = registryOwner(mainWorktree, registryDir);
  for (const file of [
    "workspaces.json",
    "dev-servers.json",
    "dev-startups.json",
    "workspaces.lock",
  ])
    assertRegistryPath(mainWorktree, expected.registryDir, join(expected.registryDir, file));
  const file = join(expected.registryDir, "workspaces.json");
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) {
    assertUnclaimedStorage(expected, file);
    return;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WorkspaceError(
      `Invalid or unsupported registry ${file}. Account for running services and resources before upgrading registry state.`,
      { cause: error },
    );
  }
  if (!isObject(stored) || stored.version !== 4 || !isObject(stored.storage))
    throw ownershipError(file, "invalid or unsupported registry ownership");
  const owner = stored.storage;
  if (
    owner.in !== expected.in ||
    typeof owner.registryDir !== "string" ||
    typeof owner.mainWorktree !== "string" ||
    !isAbsolute(owner.mainWorktree) ||
    !isAbsolute(owner.registryDir) ||
    canonicalPath(owner.mainWorktree) !== owner.mainWorktree ||
    resolve(owner.registryDir) !== owner.registryDir
  )
    throw ownershipError(file, "foreign or relocated registry ownership");
  const localMove =
    expected.in === "project" &&
    relative(owner.mainWorktree, owner.registryDir) ===
      relative(expected.mainWorktree, expected.registryDir);
  if (owner.registryDir !== expected.registryDir && !localMove)
    throw ownershipError(file, "foreign or relocated registry ownership");
  // Physical local ownership permits main relocation; external mappings require explicit recovery.
  if (expected.in === "companion" && owner.mainWorktree !== expected.mainWorktree)
    throw ownershipError(file, "foreign or relocated main ownership");
}

function assertUnclaimedStorage(expected: RegistryOwner, file: string): void {
  const entries =
    lstatSync(expected.registryDir, { throwIfNoEntry: false }) === undefined
      ? []
      : readdirSync(expected.registryDir);
  if (entries.includes("slots.json"))
    throw new WorkspaceError(
      `Unsupported retired registry ${join(expected.registryDir, "slots.json")}. Account for its services and resources before explicitly upgrading state.`,
    );
  if (entries.some((name) => name !== "workspaces.lock"))
    throw ownershipError(file, "nonempty unowned storage");
  if (expected.in !== "companion") return;
  const worktrees = resolve(expected.registryDir, "../worktrees");
  assertDirectoryPath(dirname(dirname(expected.registryDir)), worktrees);
  if (lstatSync(worktrees, { throwIfNoEntry: false }) === undefined) return;
  for (const name of readdirSync(worktrees)) {
    const destination = join(worktrees, name);
    const entry = lstatSync(destination);
    if (!entry.isDirectory() || entry.isSymbolicLink() || readdirSync(destination).length !== 0)
      throw ownershipError(file, "runtime directories without their registry owner");
  }
}

export function assertRegistryPath(mainWorktree: string, registryDir: string, path: string): void {
  const owner = registryOwner(mainWorktree, registryDir);
  const root =
    owner.in === "project" ? canonicalPath(mainWorktree) : dirname(dirname(owner.registryDir));
  assertPath(root, path, false);
}

export function assertDirectoryPath(root: string, path: string): void {
  assertPath(root, path, true);
}

function assertPath(root: string, path: string, directory: boolean): void {
  const child = relative(root, resolve(path));
  if (root !== canonicalPath(root))
    throw new WorkspaceError(`Registry ownership requires a canonical trusted root: ${root}.`);
  if (!isWithin(root, resolve(path)))
    throw new WorkspaceError(
      `Registry ownership path must remain below its trusted root: ${path}.`,
    );
  let current = root;
  const parts = child.split(sep);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) return;
    const valid = directory || index < parts.length - 1 ? entry.isDirectory() : entry.isFile();
    if (entry.isSymbolicLink() || !valid)
      throw new WorkspaceError(
        `Registry ownership requires local directories and regular files: ${current}. Preserve existing state and repair the destination before retrying.`,
      );
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownershipError(path: string, reason: string): WorkspaceError {
  return new WorkspaceError(
    `Invalid or unsupported registry ownership at ${path}: ${reason}. Preserve state and account for services and resources before explicit recovery; automatic migration is not supported.`,
  );
}
