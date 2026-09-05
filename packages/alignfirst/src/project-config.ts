import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type } from "arktype";
import semver from "semver";

import { CliError } from "./cli-error.js";
import { errorMessage } from "./errors.js";

export const PROJECT_CONFIG_FILENAME = ".alignfirst.json";

const portRangeSchema = type({
  "+": "reject",
  first: "1 <= number.integer <= 65535",
  last: "1 <= number.integer <= 65535",
});

const plansSchema = type({
  "+": "reject",
  "folder?": "string > 0",
  "autoArchive?": "boolean",
});
const commitSchema = type({
  "+": "reject",
  style: "'conventionalCommit'",
  "ticketReference?": "'bracketed' | 'bracketedHash'",
});
const gitSchema = type({
  "+": "reject",
  "defaultBranch?": "string > 0",
  "branchNameTemplate?": "string > 0",
  "commit?": commitSchema,
  "agentCoauthoring?": "boolean",
});
const projectConfigSchema = type({
  "+": "reject",
  schemaVersion: "1",
  "cli?": "string > 0",
  "ticketIdPattern?": "string > 0",
  "plans?": plansSchema,
  "portRange?": portRangeSchema,
  "git?": gitSchema,
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
  source: "root";
}

export function resolveProjectConfig(cwd: string): ResolvedProjectConfig | undefined {
  const config = readProjectConfig(cwd);
  return config === undefined ? undefined : { config, source: "root" };
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

export function validateProjectConfig(value: unknown, label: string): ProjectConfig {
  const config = projectConfigSchema(value);
  if (config instanceof type.errors) throw invalidConfig(label, config.summary.split("\n", 1)[0]);
  if (config.cli !== undefined && semver.validRange(config.cli) === null)
    throw invalidConfig(label, `cli is not a valid semver range: ${config.cli}`);
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
}

function assertValidPortRange(range: PortRange, label: string): void {
  if (range.first > range.last)
    throw invalidConfig(label, "portRange.first must not exceed portRange.last");
}
