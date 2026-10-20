import { describeAlignfirst, forwardSettingsWarnings, runAlignfirst } from "../alignfirst-cli.js";
import { errorMessage } from "../errors.js";
import type { PortRange } from "./markers.js";

export type ItemName =
  | ".alignfirst.json"
  | ".alignfirst-instructions"
  | "DEVELOPERS.md"
  | "docs"
  | ".plans"
  | "_aligndev";

// The `alignfirst config --json` report, reduced to what aligndev reads.
export interface ProjectReport {
  // Where `.alignfirst.json` was read; null when it exists nowhere.
  source: ConfigSource | null;
  cli: ProjectCliReport | null;
  config: ProjectConfigView | null;
  companion: CompanionReport | null;
  aligndev: AligndevProjectSettings | null;
  locations: Record<ItemName, ItemLocation>;
}

export interface AligndevProjectSettings {
  profile: string;
}

export type ConfigSource = "project" | "companion";

export interface ProjectCliReport {
  installed: string;
  range: string;
  satisfied: boolean;
}

export interface ProjectConfigView {
  ticketIdPattern?: string;
  plans?: { repositoryFolder?: string };
  portRange?: PortRange;
}

export interface CompanionReport {
  dir: string;
  exists: boolean;
}

export interface ItemLocation {
  path: string;
  in: "project" | "companion";
  exists: boolean;
}

export interface ProjectError {
  error: string;
}

export function readProjectReport(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ProjectReport | ProjectError {
  const result = runAlignfirst(command, ["config", "--json"], cwd, env);
  if (result.status !== 0) {
    const error = firstLine(forwardSettingsWarnings(result.stderr));
    return { error: error === "" ? "alignfirst config failed" : error };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Invalid alignfirst config report for ${cwd}: ${errorMessage(error)} ${describeAlignfirst(command, cwd, env)}`,
    );
  }
  if (isOutdatedReport(value)) {
    return { error: `${outdatedAlignfirst(cwd)} ${describeAlignfirst(command, cwd, env)}` };
  }
  try {
    return parseProjectReport(value, cwd);
  } catch (error) {
    throw new Error(`${errorMessage(error)} ${describeAlignfirst(command, cwd, env)}`);
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n", 1)[0] ?? "";
}

// Detect the contract rather than the package version, including unreleased checkout builds.
function isOutdatedReport(value: unknown): boolean {
  return (
    isRecord(value) &&
    (!Object.hasOwn(value, "aligndev") ||
      !(isRecord(value.locations) && ".alignfirst-instructions" in value.locations))
  );
}

function outdatedAlignfirst(path: string): string {
  return (
    `The alignfirst CLI used in ${path} is too old: aligndev requires the profile-aware ` +
    'alignfirst config --json contract (top-level "aligndev"). Upgrade alignfirst.'
  );
}

function parseProjectReport(value: unknown, path: string): ProjectReport {
  if (!isRecord(value)) throw invalidReport(path);
  return {
    source: parseSource(value.source, path),
    cli: parseCli(value.cli, path),
    config: parseConfig(value.config, path),
    companion: parseCompanion(value.companion, path),
    aligndev: parseAligndev(value.aligndev, path),
    locations: parseLocations(value.locations, path),
  };
}

function parseAligndev(value: unknown, path: string): AligndevProjectSettings | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.profile !== "string" ||
    value.profile.trim().length === 0 ||
    Object.keys(value).some((key) => key !== "profile")
  )
    throw invalidReport(path);
  return { profile: value.profile };
}

function parseSource(value: unknown, path: string): ConfigSource | null {
  if (value === "project" || value === "companion" || value === null) return value;
  throw invalidReport(path);
}

function parseCli(value: unknown, path: string): ProjectCliReport | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.installed !== "string" ||
    typeof value.range !== "string" ||
    typeof value.satisfied !== "boolean"
  ) {
    throw invalidReport(path);
  }
  return { installed: value.installed, range: value.range, satisfied: value.satisfied };
}

function parseConfig(value: unknown, path: string): ProjectConfigView | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidReport(path);
  const ticketIdPattern = value.ticketIdPattern;
  const plans = parsePlans(value.plans, path);
  const portRange = value.portRange;
  if (ticketIdPattern !== undefined && typeof ticketIdPattern !== "string")
    throw invalidReport(path);
  if (portRange !== undefined && !isPortRange(portRange)) throw invalidReport(path);
  return {
    ...(ticketIdPattern === undefined ? {} : { ticketIdPattern }),
    ...(plans === undefined ? {} : { plans }),
    ...(portRange === undefined ? {} : { portRange }),
  };
}

function parsePlans(value: unknown, path: string): { repositoryFolder?: string } | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidReport(path);
  // Before alignfirst 0.12.0, the report named this key `folder`.
  const repositoryFolder = value.repositoryFolder ?? value.folder;
  if (repositoryFolder !== undefined && typeof repositoryFolder !== "string")
    throw invalidReport(path);
  return repositoryFolder === undefined ? {} : { repositoryFolder };
}

// The report's other companion fields (`key`, `items`) are alignfirst's concern.
function parseCompanion(value: unknown, path: string): CompanionReport | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.dir !== "string" || typeof value.exists !== "boolean") {
    throw invalidReport(path);
  }
  return { dir: value.dir, exists: value.exists };
}

function parseLocations(value: unknown, path: string): Record<ItemName, ItemLocation> {
  if (!isRecord(value)) throw invalidReport(path);
  const location = (name: ItemName) => parseLocation(value[name], path);
  return {
    ".alignfirst.json": location(".alignfirst.json"),
    ".alignfirst-instructions": location(".alignfirst-instructions"),
    "DEVELOPERS.md": location("DEVELOPERS.md"),
    docs: location("docs"),
    ".plans": location(".plans"),
    _aligndev: location("_aligndev"),
  };
}

function parseLocation(value: unknown, path: string): ItemLocation {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    (value.in !== "project" && value.in !== "companion") ||
    typeof value.exists !== "boolean"
  ) {
    throw invalidReport(path);
  }
  return { path: value.path, in: value.in, exists: value.exists };
}

function invalidReport(path: string): Error {
  return new Error(`Invalid alignfirst config report for ${path}`);
}

function isPortRange(value: unknown): value is PortRange {
  return isRecord(value) && typeof value.first === "number" && typeof value.last === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Some of the given items exists in the companion directory.
export function companionInUse(report: ProjectReport, items: readonly ItemName[]): boolean {
  return items.some((item) => {
    const location = report.locations[item];
    return location.in === "companion" && location.exists;
  });
}
