import { readFileSync } from "node:fs";

import { CliError } from "./cli-error.js";
import type { Output } from "./context.js";
import { errorMessage } from "./errors.js";
import {
  boolean,
  integerBetween,
  isPlainObject,
  literal,
  nonEmptyString,
  object,
  optional,
  parseShape,
} from "./json-shape.js";
import type { ProjectLayout } from "./project-layout.js";
import { warnUnknownSetting } from "./settings-warning.js";
import { isValidVersionRange } from "./version-range.js";

export const PROJECT_CONFIG_FILENAME = ".alignfirst.json";

const portRangeShape = object<PortRange>(
  { first: integerBetween(1, 65_535), last: integerBetween(1, 65_535) },
  warnUnknownProjectSetting,
);
const plansShape = object<PlansConfig>(
  { repositoryFolder: optional(nonEmptyString), autoArchive: optional(boolean) },
  warnUnknownProjectSetting,
);
const commitShape = object<CommitConfig>(
  {
    style: literal("conventionalCommit"),
    ticketReference: optional(literal("bracketed", "bracketedHash")),
  },
  warnUnknownProjectSetting,
);
const gitShape = object<GitConfig>(
  {
    defaultBranch: optional(nonEmptyString),
    branchNameTemplate: optional(nonEmptyString),
    commit: optional(commitShape),
    agentCoauthoring: optional(boolean),
  },
  warnUnknownProjectSetting,
);
const projectConfigShape = object<ProjectConfig>(
  {
    schemaVersion: literal(1),
    cli: optional(nonEmptyString),
    ticketIdPattern: optional(nonEmptyString),
    plans: optional(plansShape),
    portRange: optional(portRangeShape),
    git: optional(gitShape),
  },
  warnUnknownProjectSetting,
);

export interface ProjectConfig {
  schemaVersion: 1;
  cli?: string;
  ticketIdPattern?: string;
  plans?: PlansConfig;
  portRange?: PortRange;
  git?: GitConfig;
}

export interface PlansConfig {
  repositoryFolder?: string;
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

export interface ResolvedProjectConfig extends ProjectConfigFile {
  source: "project" | "companion";
}

export interface ProjectConfigFile {
  config: ProjectConfig;
  /** One message per deprecated key the file still uses. */
  deprecations: string[];
}

export function resolveProjectConfig(layout: ProjectLayout): ResolvedProjectConfig | undefined {
  const location = layout.locations[PROJECT_CONFIG_FILENAME];
  if (!location.exists) return;
  return { ...readProjectConfig(location.path), source: location.in };
}

export function writeDeprecationWarnings(
  stderr: Output,
  resolved: ResolvedProjectConfig | undefined,
): void {
  for (const message of resolved?.deprecations ?? []) stderr.write(`Warning: ${message}\n`);
}

export function readProjectConfig(path: string): ProjectConfigFile {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidConfig(path, "must contain valid JSON");
  }
  const config = validateProjectConfig(value, path);
  const deprecations = hasLegacyPlansFolder(value) ? [legacyPlansFolderWarning(path)] : [];
  return { config, deprecations };
}

export function validateProjectConfig(value: unknown, label: string): ProjectConfig {
  const config = parseShape(projectConfigShape, migrateLegacyPlansFolder(value, label), (detail) =>
    invalidConfig(label, detail),
  );
  if (config.cli !== undefined && !isValidVersionRange(config.cli))
    throw invalidConfig(label, "cli is not a supported version range");
  if (config.ticketIdPattern !== undefined) assertValidPattern(config.ticketIdPattern, label);
  if (config.portRange !== undefined) assertValidPortRange(config.portRange, label);
  return config;
}

function warnUnknownProjectSetting(path: string, key: string): void {
  const hint =
    path === "" && key === "ticketPattern" ? "Use ticketIdPattern for ticket matching." : undefined;
  warnUnknownSetting(PROJECT_CONFIG_FILENAME, path, key, hint);
}

/** Reads the deprecated `plans.folder` as `plans.repositoryFolder`. */
function migrateLegacyPlansFolder(value: unknown, label: string): unknown {
  if (!hasLegacyPlansFolder(value)) return value;
  const { folder, ...plans } = value.plans;
  if ("repositoryFolder" in plans)
    throw invalidConfig(
      label,
      "plans.folder duplicates plans.repositoryFolder; remove plans.folder",
    );
  return { ...value, plans: { ...plans, repositoryFolder: folder } };
}

function hasLegacyPlansFolder(
  value: unknown,
): value is { plans: Record<string, unknown> } & Record<string, unknown> {
  return isPlainObject(value) && isPlainObject(value.plans) && "folder" in value.plans;
}

function legacyPlansFolderWarning(label: string): string {
  return (
    `${label}: plans.folder is deprecated; rename it to plans.repositoryFolder. ` +
    `See "Rename the Work-Files Folder Setting" in the setup guide's alignfirst-upgrade reference.`
  );
}

function invalidConfig(label: string, detail: string): CliError {
  return new CliError(`Invalid ${label}: ${detail}`);
}

function assertValidPattern(pattern: string, label: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw invalidConfig(label, "ticketIdPattern is not a valid regular expression");
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
