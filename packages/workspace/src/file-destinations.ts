import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ConfigError } from "./errors.js";

export function assertFileDestination(root: string, path: string, registryDir?: string): string {
  const target = resolve(root, path);
  if (path.includes("\0") || isAbsolute(path) || !isWithin(resolve(root), target)) {
    throw new ConfigError(`File destination escapes worktree: ${path}.`);
  }
  if (relative(resolve(root), target).split(sep)[0] === ".git") {
    throw new ConfigError(`Refusing Git metadata destination: ${path}.`);
  }
  const registries = [
    resolve(root, ".local-wt", "workspace-registry"),
    ...(registryDir === undefined ? [] : [registryDir]),
  ];
  const canonical = canonicalDestination(target);
  for (const registry of registries) {
    if (overlaps(registry, target) || overlaps(canonicalDestination(registry), canonical))
      throw new ConfigError(
        `Refusing kernel-owned registry destination or canonical alias: ${path}.`,
      );
  }
  if (!isWithin(realpathSync(root), canonical)) {
    throw new ConfigError(`File destination escapes worktree through a link: ${path}.`);
  }
  assertUntracked(root, relative(root, target));
  const canonicalRelative = relative(realpathSync(root), canonical);
  if (canonicalRelative.split(sep)[0] === ".git") {
    throw new ConfigError(`Refusing Git metadata destination: ${path}.`);
  }
  assertUntracked(root, canonicalRelative);
  return canonical;
}

export function assertDistinctDestinations(
  root: string,
  paths: string[],
  registryDir?: string,
): void {
  const destinations = new Set<string>();
  for (const path of paths) {
    const target = assertFileDestination(root, path, registryDir);
    if (destinations.has(target)) throw new ConfigError(`Overlapping file destination: ${path}.`);
    destinations.add(target);
  }
}

function canonicalDestination(path: string): string {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry !== undefined) {
    if (entry.isSymbolicLink()) {
      try {
        return realpathSync(path);
      } catch {
        throw new ConfigError(`Unusable file destination link: ${path}.`);
      }
    }
    return realpathSync(path);
  }
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(canonicalDestination(parent), relative(parent, path));
}

function overlaps(first: string, second: string): boolean {
  return first === second || isWithin(first, second) || isWithin(second, first);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertUntracked(root: string, path: string): void {
  // Helpers also support non-Git scratch directories. Within Git, inspection must fail closed.
  const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  if (repository.status !== 0) {
    if (repository.error || lstatSync(resolve(root, ".git"), { throwIfNoEntry: false })) {
      throw new ConfigError(`Cannot inspect tracked destination: ${path}.`);
    }
    return;
  }
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
  });
  if (head.error || head.signal !== null || (head.status !== 0 && head.status !== 1))
    throw new ConfigError(`Cannot inspect tracked destination: ${path}.`);
  let candidate = path;
  while (candidate !== ".") {
    const tracked = spawnSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", candidate], {
      cwd: root,
      encoding: "utf8",
    });
    if (tracked.status !== 0) throw new ConfigError(`Cannot inspect tracked destination: ${path}.`);
    const committed =
      head.status === 0
        ? spawnSync(
            "git",
            [
              "--literal-pathspecs",
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              head.stdout.trim(),
              "--",
              candidate,
            ],
            { cwd: root, encoding: "utf8" },
          )
        : undefined;
    if (committed && committed.status !== 0)
      throw new ConfigError(`Cannot inspect tracked destination: ${path}.`);
    const files = tracked.stdout + (committed?.stdout ?? "");
    if (files.length > 0) {
      // Ancestors must reject tracked files/links, without rejecting unrelated tracked siblings.
      const entries = files.split("\0");
      if (candidate === path || entries.includes(candidate)) {
        throw new ConfigError(`Refusing tracked file destination: ${path}.`);
      }
    }
    candidate = dirname(candidate);
  }
}
