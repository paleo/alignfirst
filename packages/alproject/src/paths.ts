import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { AlprojectError, errorMessage, isNodeError } from "./errors.js";

export function expandHomePath(path: string, home: string): string {
  if (!path.startsWith("~/")) return path;
  return join(home, path.slice(2));
}

export function normalizeAbsolutePath(path: string, home: string): string {
  const expandedPath = expandHomePath(path, home);
  if (!isAbsolute(expandedPath)) {
    throw new AlprojectError("filesystem", `Path must be absolute: ${path}`);
  }
  return normalize(expandedPath);
}

export function canonicalizePath(path: string): string {
  const normalizedPath = normalize(path);
  try {
    return realpathSync(normalizedPath);
  } catch (error) {
    if (isMissingPathError(error)) return normalizedPath;
    throw new AlprojectError(
      "filesystem",
      `Cannot resolve path ${normalizedPath}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function resolveProjectPath(path: string, root: string): string {
  if (path.length === 0) throw new AlprojectError("filesystem", "Project path is required");
  const absolutePath = isAbsolute(path) ? normalize(path) : resolve(root, path);
  return canonicalizePath(absolutePath);
}

export function resolveConfiguredPath(path: string, home: string): string {
  return canonicalizePath(normalizeAbsolutePath(path, home));
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
