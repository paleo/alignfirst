import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type } from "arktype";
import semver from "semver";

import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";

export const PROJECT_CONFIG_FILENAME = ".alignfirst.json";

export const portRangeSchema = type({
  "+": "reject",
  first: "1 <= number.integer <= 65535",
  last: "1 <= number.integer <= 65535",
});

const plansSchema = type({
  "+": "reject",
  folder: "string > 0",
});
const projectSchema = type({
  "+": "reject",
  "remote?": "string > 0",
  "paths?": "string[]",
});
const projectConfigSchema = type({
  "+": "reject",
  schemaVersion: "1",
  "cli?": "string > 0",
  "ticketPattern?": "string > 0",
  "plans?": plansSchema,
  "portRange?": portRangeSchema,
  "project?": projectSchema,
});

export interface ProjectConfig {
  schemaVersion: 1;
  cli?: string;
  ticketPattern?: string;
  plans?: PlansConfig;
  portRange?: PortRange;
  project?: ProjectIdentity;
}

export interface PlansConfig {
  folder: string;
}

export interface PortRange {
  first: number;
  last: number;
}

export interface ProjectIdentity {
  remote?: string;
  paths?: string[];
}

export function validateProjectConfig(value: unknown, label: string): ProjectConfig {
  const config = projectConfigSchema(value);
  if (config instanceof type.errors) throw invalidConfig(label, config.summary.split("\n", 1)[0]);
  if (config.cli !== undefined && semver.validRange(config.cli) === null)
    throw invalidConfig(label, `cli is not a valid semver range: ${config.cli}`);
  if (config.ticketPattern !== undefined) assertValidPattern(config.ticketPattern, label);
  if (config.portRange !== undefined) assertValidPortRange(config.portRange, label);
  if (config.project !== undefined) assertValidProjectIdentity(config.project, label);
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
      `ticketPattern is not a valid regular expression: ${errorMessage(error)}`,
    );
  }
}

export function assertValidPortRange(range: PortRange, label: string): void {
  if (range.first > range.last)
    throw invalidConfig(label, "portRange.first must not exceed portRange.last");
}

function assertValidProjectIdentity(project: ProjectIdentity, label: string): void {
  if (project.remote === undefined && project.paths === undefined)
    throw invalidConfig(label, "project must contain remote or paths");
  const relativePath = project.paths?.find((path) => !isAbsolute(path));
  if (relativePath !== undefined)
    throw invalidConfig(label, `project.paths must contain only absolute paths: ${relativePath}`);
}

export function readProjectConfig(dir: string): ProjectConfig | undefined {
  const path = join(dir, PROJECT_CONFIG_FILENAME);
  if (!existsSync(path)) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  return validateProjectConfig(value, path);
}
