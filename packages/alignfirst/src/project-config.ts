import { readFileSync } from "node:fs";

import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";
import {
  boolean,
  integerBetween,
  literal,
  nonEmptyString,
  object,
  optional,
  parseShape,
} from "./json-shape.js";
import type { ProjectLayout } from "./project-layout.js";
import { isValidVersionRange } from "./version-range.js";

export const PROJECT_CONFIG_FILENAME = ".alignfirst.json";

const portRangeShape = object<PortRange>({
  first: integerBetween(1, 65_535),
  last: integerBetween(1, 65_535),
});
const plansShape = object<PlansConfig>({
  folder: optional(nonEmptyString),
  autoArchive: optional(boolean),
});
const commitShape = object<CommitConfig>({
  style: literal("conventionalCommit"),
  ticketReference: optional(literal("bracketed", "bracketedHash")),
});
const gitShape = object<GitConfig>({
  defaultBranch: optional(nonEmptyString),
  branchNameTemplate: optional(nonEmptyString),
  commit: optional(commitShape),
  agentCoauthoring: optional(boolean),
});
const projectConfigShape = object<ProjectConfig>({
  schemaVersion: literal(1),
  cli: optional(nonEmptyString),
  ticketIdPattern: optional(nonEmptyString),
  plans: optional(plansShape),
  portRange: optional(portRangeShape),
  git: optional(gitShape),
});

export interface ProjectConfig {
  schemaVersion: 1;
  cli?: string;
  ticketIdPattern?: string;
  plans?: PlansConfig;
  portRange?: PortRange;
  git?: GitConfig;
}

export interface PlansConfig {
  folder?: string;
  autoArchive?: boolean;
}

export interface PortRange {
  first: number;
  last: number;
}

export interface GitConfig {
  defaultBranch?: string;
  branchNameTemplate?: string;
  commit?: CommitConfig;
  agentCoauthoring?: boolean;
}

export interface CommitConfig {
  style: "conventionalCommit";
  ticketReference?: "bracketed" | "bracketedHash";
}

export interface ResolvedProjectConfig {
  config: ProjectConfig;
  source: "project" | "companion";
}

export function resolveProjectConfig(layout: ProjectLayout): ResolvedProjectConfig | undefined {
  const location = layout.locations[PROJECT_CONFIG_FILENAME];
  if (!location.exists) return;
  return { config: readProjectConfig(location.path), source: location.in };
}

export function readProjectConfig(path: string): ProjectConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  return validateProjectConfig(value, path);
}

export function validateProjectConfig(value: unknown, label: string): ProjectConfig {
  const config = parseShape(projectConfigShape, value, (detail) => invalidConfig(label, detail));
  if (config.cli !== undefined && !isValidVersionRange(config.cli))
    throw invalidConfig(label, `cli is not a supported version range: ${config.cli}`);
  if (config.ticketIdPattern !== undefined) assertValidPattern(config.ticketIdPattern, label);
  if (config.portRange !== undefined) assertValidPortRange(config.portRange, label);
  return config;
}

function invalidConfig(label: string, detail: string): CliError {
  return new CliError(`Invalid ${label}: ${detail}`);
}

function assertValidPattern(pattern: string, label: string): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    throw invalidConfig(
      label,
      `ticketIdPattern is not a valid regular expression: ${errorMessage(error)}`,
    );
  }
  if (hasInnerAnchor(pattern))
    throw invalidConfig(
      label,
      "ticketIdPattern must be one anchored expression; group alternatives: ^(ABC|XYZ)-\\d+$",
    );
}

/** Branch detection unanchors the pattern by trimming its ends, so inner anchors never match. */
function hasInnerAnchor(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; ++i) {
    const char = pattern[i];
    if (char === "\\") ++i;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "^" && i !== 0) return true;
    else if (char === "$" && i !== pattern.length - 1) return true;
  }
  return false;
}

function assertValidPortRange(range: PortRange, label: string): void {
  if (range.first > range.last)
    throw invalidConfig(label, "portRange.first must not exceed portRange.last");
}
