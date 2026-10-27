import {
  readConfigFile,
  validateConfigSchema,
  validateWorkspaceSettings,
  type WorkspaceManifest,
} from "@alignfirst/workspace/config";
import { readFileSync } from "node:fs";

import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";
import type { ProjectLayout } from "./project-layout.js";

export const PROJECT_CONFIG_FAMILY = "alignfirst";
const projectSchema: object = JSON.parse(
  readFileSync(new URL("../schemas/alignfirst-v1.schema.json", import.meta.url), "utf8"),
);

export interface ProjectConfig extends WorkspaceManifest {
  schemaVersion: 1;
  $schema?: string;
  conventions?: ConventionsConfig;
  plans?: PlansConfig;
  developerInstructions?: string;
}

export interface ConventionsConfig {
  ticketIdPattern?: string;
  git?: GitConfig;
}

export interface PlansConfig {
  repositoryFolder?: string;
  autoArchive?: boolean;
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
}

export function resolveProjectConfig(layout: ProjectLayout): ResolvedProjectConfig | undefined {
  return layout.projectConfig;
}

export function readProjectConfig(path: string): ProjectConfigFile {
  try {
    return { config: validateProjectConfig(readConfigFile(path), path) };
  } catch (error) {
    throw new CliError(errorMessage(error));
  }
}

export function validateProjectConfig(value: unknown, label: string): ProjectConfig {
  try {
    validateConfigSchema<ProjectConfig>(value, projectSchema, label);
  } catch (error) {
    throw new CliError(errorMessage(error));
  }
  if (value.conventions?.ticketIdPattern !== undefined)
    assertValidPattern(value.conventions.ticketIdPattern, label);
  try {
    validateWorkspaceSettings(value, label);
  } catch (error) {
    throw new CliError(errorMessage(error));
  }
  return value;
}

function assertValidPattern(pattern: string, label: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new CliError(`Invalid ${label}: ticketIdPattern is not a valid regular expression`);
  }
  if (hasInnerAnchor(pattern))
    throw new CliError(
      `Invalid ${label}: ticketIdPattern must be one anchored expression; group alternatives: ^(ABC|XYZ)-\\d+$`,
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
