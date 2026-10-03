import { runAlignfirst } from "../alignfirst-cli.js";
import { errorMessage } from "../errors.js";
import type { PortRange } from "./markers.js";

const MIN_ALIGNFIRST_VERSION = "0.5.0";

export type ItemName =
  | ".alignfirst.json"
  | ".alignfirst.md"
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
  locations: Record<ItemName, ItemLocation>;
}

export type ConfigSource = "project" | "companion";

export interface ProjectCliReport {
  installed: string;
  range: string;
  satisfied: boolean;
}

export interface ProjectConfigView {
  ticketIdPattern?: string;
  plans?: { folder?: string };
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
    const error = firstLine(result.stderr);
    return { error: error === "" ? "alignfirst config failed" : error };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Invalid alignfirst config report for ${cwd}: ${errorMessage(error)}`);
  }
  return parseProjectReport(value, cwd);
}

function firstLine(value: string): string {
  return value.trim().split("\n", 1)[0] ?? "";
}

function parseProjectReport(value: unknown, path: string): ProjectReport {
  if (!isRecord(value)) throw invalidReport(path);
  if (value.source === "root" || value.locations === undefined) throw outdatedAlignfirst(path);
  return {
    source: parseSource(value.source, path),
    cli: parseCli(value.cli, path),
    config: parseConfig(value.config, path),
    companion: parseCompanion(value.companion, path),
    locations: parseLocations(value.locations, path),
  };
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

function parsePlans(value: unknown, path: string): { folder?: string } | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidReport(path);
  if (value.folder !== undefined && typeof value.folder !== "string") throw invalidReport(path);
  return value.folder === undefined ? {} : { folder: value.folder };
}

// The report's other companion fields (`entries`, `flags`) are alignfirst's concern.
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
    ".alignfirst.md": location(".alignfirst.md"),
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

function outdatedAlignfirst(path: string): Error {
  return new Error(
    `The alignfirst CLI used in ${path} is too old: aligndev requires alignfirst ` +
      `${MIN_ALIGNFIRST_VERSION} or later.`,
  );
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
