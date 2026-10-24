import { type Invocation, packageCommand, renderCommand } from "@alignfirst/docmap/invocation";
import { CliError } from "./cli-error.js";
import type { ProjectConfig } from "./project-config.js";
import { satisfiesRange } from "./version-range.js";

export interface CliRangeResult {
  range: string;
  satisfied: boolean;
}

export function checkCliRange(
  config: ProjectConfig | undefined,
  installedVersion: string,
  commandArgs: string[],
  invocation: Invocation,
): void {
  const result = cliRangeResult(config, installedVersion);
  if (result === undefined || result.satisfied) return;
  const recovery = packageCommand(invocation, invocation.target, `alignfirst@${result.range}`);
  throw new CliError(
    `alignfirst ${installedVersion} is installed; this project requires ${result.range}.\n` +
      `Run a matching version:  ${renderCommand(recovery, commandArgs)}`,
  );
}

export function cliRangeResult(
  config: ProjectConfig | undefined,
  installedVersion: string,
): CliRangeResult | undefined {
  const range = config?.cli;
  if (range === undefined) return;
  return { range, satisfied: satisfiesRange(installedVersion, range) };
}
