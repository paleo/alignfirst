import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import { type } from "arktype";

import type { AlprojectConfig } from "./config.js";
import { AlprojectError } from "./errors.js";
import { canonicalizePath } from "./paths.js";
import { allocationEnd } from "./ports.js";

export const REGISTRY_FILENAME = "alproject-registry.json";

const portsSchema = type({
  "+": "reject",
  basePort: "number.integer >= 1",
  maxWorkspaces: "number.integer >= 1",
  portsPerWorkspace: "number.integer >= 1",
});
const projectEntrySchema = type({
  "+": "reject",
  path: "string > 0",
  "ports?": portsSchema,
});
const registrySchema = type({
  "+": "reject",
  projects: projectEntrySchema.array(),
  version: "1",
});

export type PortAllocation = typeof portsSchema.infer;
export type ProjectEntry = typeof projectEntrySchema.infer;
export type Registry = typeof registrySchema.infer;

interface PortRange {
  end: number;
  path: string;
  start: number;
}

export function registryPath(config: Pick<AlprojectConfig, "root">): string {
  return join(config.root, REGISTRY_FILENAME);
}

export function readRegistry(config: AlprojectConfig): Registry {
  const path = registryPath(config);
  const rawRegistry = readRegistryFile(path);
  if (rawRegistry === undefined) return { projects: [], version: 1 };

  const registry = registrySchema(rawRegistry);
  if (registry instanceof type.errors) {
    throw registryError(path, registry.summary);
  }
  validateRegistry(registry, config, path);
  return registry;
}

function readRegistryFile(path: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw registryError(path, `cannot read file: ${errorMessage(error)}`, error);
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw registryError(path, `invalid JSON: ${errorMessage(error)}`, error);
  }
}

function validateRegistry(registry: Registry, config: AlprojectConfig, path: string): void {
  validateProjectPaths(registry.projects, path);
  const ranges = registry.projects.flatMap((project) =>
    project.ports === undefined ? [] : [portRange(project, config, path)],
  );
  validateNonOverlappingRanges(ranges, path);
}

function validateProjectPaths(projects: readonly ProjectEntry[], registryFile: string): void {
  const seenPaths = new Set<string>();
  for (const project of projects) {
    if (!isAbsolute(project.path)) {
      throw registryError(registryFile, `project path must be absolute: ${project.path}`);
    }
    const normalizedPath = normalize(project.path);
    if (normalizedPath !== project.path || canonicalizePath(project.path) !== project.path) {
      throw registryError(registryFile, `project path must be canonical: ${project.path}`);
    }
    if (seenPaths.has(project.path)) {
      throw registryError(registryFile, `duplicate project path: ${project.path}`);
    }
    seenPaths.add(project.path);
  }
}

function portRange(
  project: ProjectEntry,
  config: AlprojectConfig,
  registryFile: string,
): PortRange {
  const ports = project.ports;
  if (ports === undefined) throw new Error("Port allocation is required");
  for (const [field, value] of Object.entries(ports)) {
    if (!Number.isSafeInteger(value)) {
      throw registryError(registryFile, `${field} must be a safe integer for ${project.path}`);
    }
  }
  if (ports.basePort < config.firstPort || ports.basePort > config.lastPort) {
    throw registryError(
      registryFile,
      `basePort for ${project.path} must be within ${config.firstPort}..${config.lastPort}`,
    );
  }

  let end: number;
  try {
    end = allocationEnd(ports);
  } catch (error) {
    throw registryError(registryFile, errorMessage(error), error);
  }
  if (end > config.lastPort) {
    throw registryError(
      registryFile,
      `port allocation for ${project.path} exceeds configured range ending at ${config.lastPort}`,
    );
  }
  return { end, path: project.path, start: ports.basePort };
}

function validateNonOverlappingRanges(ranges: PortRange[], registryFile: string): void {
  const sortedRanges = ranges.toSorted((left, right) => left.start - right.start);
  for (let index = 1; index < sortedRanges.length; ++index) {
    const previous = sortedRanges[index - 1];
    const current = sortedRanges[index];
    if (current.start <= previous.end) {
      throw registryError(
        registryFile,
        `port allocations overlap for ${previous.path} and ${current.path}`,
      );
    }
  }
}

function registryError(path: string, detail: string, cause?: unknown): AlprojectError {
  return new AlprojectError("registry", `Invalid registry ${path}: ${detail}`, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
