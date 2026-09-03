import semver from "semver";

import { CliError } from "./cli-error.js";
import type { ProjectConfig } from "./project-config.js";

export interface CliRangeResult {
  range: string;
  satisfied: boolean;
}

export function defaultCliRange(version: string): string {
  const parsed = semver.parse(version);
  if (parsed === null) throw new Error(`Invalid installed version: ${version}`);
  const upper = parsed.major === 0 ? `0.${parsed.minor + 1}.0` : `${parsed.major + 1}.0.0`;
  return `>=${version} <${upper}`;
}

export function checkCliRange(
  config: ProjectConfig | undefined,
  installedVersion: string,
  commandArgs: string[],
): void {
  const result = cliRangeResult(config, installedVersion);
  if (result === undefined || result.satisfied) return;
  const command = commandArgs.join(" ");
  throw new CliError(
    `alignfirst ${installedVersion} is installed; this project requires ${result.range}.\n` +
      `Run a matching version:  npx -y alignfirst@"${result.range}" ${command}\n` +
      `Or install it globally:  npm install -g alignfirst@"${result.range}"`,
  );
}

export function cliRangeResult(
  config: ProjectConfig | undefined,
  installedVersion: string,
): CliRangeResult | undefined {
  const range = config?.cli;
  if (range === undefined) return;
  return { range, satisfied: semver.satisfies(installedVersion, range) };
}
