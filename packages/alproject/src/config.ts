import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { type } from "arktype";

import { AlprojectError, errorMessage, isNodeError } from "./errors.js";
import { resolveConfiguredPath } from "./paths.js";

export const CONFIG_FILENAME = ".alproject.json";

const portRangeSchema = type({
  "+": "reject",
  first: "1 <= number.integer <= 65535",
  last: "1 <= number.integer <= 65535",
});
const rootSchema = type({
  "+": "reject",
  path: "string > 0",
  portRange: portRangeSchema,
});
const projectParentSchema = type({
  "+": "reject",
  path: "string > 0",
  "portRange?": portRangeSchema,
});
const configSchema = type({
  "+": "reject",
  "projectParents?": projectParentSchema.array(),
  root: rootSchema,
});

type ConfigFile = typeof configSchema.infer;
type ConfiguredProjectParent = typeof projectParentSchema.infer;
type ConfiguredRoot = typeof rootSchema.infer;

export interface AlprojectConfig {
  configPath: string;
  projectParents: ProjectParent[];
  root: AlprojectRoot;
}

export interface AlprojectRoot {
  path: string;
  portRange: PortRange;
}

export interface ProjectParent {
  path: string;
  portRange?: PortRange;
}

export interface PortRange {
  first: number;
  last: number;
}

export function readConfig(home: string): AlprojectConfig {
  const configPath = join(home, CONFIG_FILENAME);
  const configFile = readConfigFile(configPath);
  const root = resolveRoot(configFile.root, home, configPath);
  const configuredParents = configFile.projectParents ?? [{ path: configFile.root.path }];
  const projectParents = resolveProjectParents(configuredParents, root.portRange, home, configPath);

  assertAccessibleDirectory(root.path, configPath, "root");
  for (const parent of projectParents) {
    assertAccessibleDirectory(parent.path, configPath, "project parent");
  }

  return { configPath, projectParents, root };
}

export function availablePortRanges(config: AlprojectConfig, projectPath: string): PortRange[] {
  const parent = config.projectParents.find((candidate) => candidate.path === dirname(projectPath));
  if (parent?.portRange !== undefined) return [parent.portRange];
  return unreservedPortRanges(config.root.portRange, config.projectParents);
}

export function readConfigIfPresent(home: string): AlprojectConfig | undefined {
  const configPath = join(home, CONFIG_FILENAME);
  try {
    statSync(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new AlprojectError(
      "configuration",
      `Cannot inspect configuration file ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return readConfig(home);
}

function readConfigFile(configPath: string): ConfigFile {
  const rawConfig = readJsonFile(configPath, "configuration");
  const config = configSchema(rawConfig);
  if (config instanceof type.errors) {
    throw configurationError(configPath, config.summary);
  }
  if (config.projectParents?.length === 0) {
    throw configurationError(configPath, "projectParents must contain at least one entry");
  }
  return config;
}

function resolveRoot(root: ConfiguredRoot, home: string, configPath: string): AlprojectRoot {
  const portRange = validatePortRange(root.portRange, "root.portRange", configPath);
  return {
    path: resolveConfigPath(root.path, home, configPath, "root.path"),
    portRange,
  };
}

function resolveProjectParents(
  parents: ConfiguredProjectParent[],
  rootRange: PortRange,
  home: string,
  configPath: string,
): ProjectParent[] {
  const resolved = parents.map((parent, index) => ({
    path: resolveConfigPath(parent.path, home, configPath, `projectParents[${index}].path`),
    ...(parent.portRange === undefined
      ? {}
      : {
          portRange: validateParentPortRange(
            parent.portRange,
            rootRange,
            `projectParents[${index}].portRange`,
            configPath,
          ),
        }),
  }));
  validateDistinctParents(resolved, configPath);
  validateNonOverlappingParentRanges(resolved, configPath);
  return resolved;
}

function resolveConfigPath(path: string, home: string, configPath: string, field: string): string {
  try {
    return resolveConfiguredPath(path, home);
  } catch (error) {
    throw configurationError(configPath, `${field}: ${errorMessage(error)}`, error);
  }
}

function validateParentPortRange(
  range: PortRange,
  rootRange: PortRange,
  field: string,
  configPath: string,
): PortRange {
  const validated = validatePortRange(range, field, configPath);
  if (validated.first < rootRange.first || validated.last > rootRange.last) {
    throw configurationError(
      configPath,
      `${field} must be within root.portRange ${formatPortRange(rootRange)}`,
    );
  }
  return validated;
}

function validatePortRange(range: PortRange, field: string, configPath: string): PortRange {
  if (range.first > range.last) {
    throw configurationError(configPath, `${field}.first must not exceed ${field}.last`);
  }
  return range;
}

function validateDistinctParents(parents: readonly ProjectParent[], configPath: string): void {
  const seen = new Set<string>();
  for (const parent of parents) {
    if (seen.has(parent.path)) {
      throw configurationError(configPath, `duplicate project parent: ${parent.path}`);
    }
    seen.add(parent.path);
  }
}

function validateNonOverlappingParentRanges(
  parents: readonly ProjectParent[],
  configPath: string,
): void {
  const ranges = parents.flatMap((parent) =>
    parent.portRange === undefined ? [] : [{ parent: parent.path, ...parent.portRange }],
  );
  const sorted = ranges.toSorted((left, right) => left.first - right.first);
  for (let index = 1; index < sorted.length; ++index) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.first <= previous.last) {
      throw configurationError(
        configPath,
        `project parent port ranges overlap for ${previous.parent} and ${current.parent}`,
      );
    }
  }
}

function unreservedPortRanges(
  rootRange: PortRange,
  parents: readonly ProjectParent[],
): PortRange[] {
  const reserved = parents
    .flatMap((parent) => (parent.portRange === undefined ? [] : [parent.portRange]))
    .toSorted((left, right) => left.first - right.first);
  const available: PortRange[] = [];
  let first = rootRange.first;
  for (const range of reserved) {
    if (first < range.first) available.push({ first, last: range.first - 1 });
    first = range.last + 1;
  }
  if (first <= rootRange.last) available.push({ first, last: rootRange.last });
  return available;
}

function formatPortRange(range: PortRange): string {
  return `${range.first}..${range.last}`;
}

function readJsonFile(path: string, label: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new AlprojectError(
      "configuration",
      `Cannot read ${label} file ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AlprojectError(
      "configuration",
      `Invalid JSON in ${label} file ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function assertAccessibleDirectory(path: string, configPath: string, field: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error("path is not a directory");
    }
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw configurationError(
      configPath,
      `${field} directory is missing or inaccessible: ${path} (${errorMessage(error)})`,
      error,
    );
  }
}

function configurationError(path: string, detail: string, cause?: unknown): AlprojectError {
  return new AlprojectError("configuration", `Invalid configuration ${path}: ${detail}`, { cause });
}
