import { lstatSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { getNodeValue, type ParseError, parseTree } from "jsonc-parser";

import { ConfigError } from "./errors.js";
import { type DevPortsConfig, type PortRange, resolveDevPortsConfig } from "./ports.js";

export const WORKSPACE_CONFIG_FAMILY = "alignfirst-workspace";
const validators = new WeakMap<object, ValidateFunction>();
const ajv = new Ajv({ allErrors: true, ownProperties: true });
ajv.addFormat("uri", fullFormats.uri);
const manifestSchema: object = JSON.parse(
  readFileSync(new URL("../schemas/workspace-v1.schema.json", import.meta.url), "utf8"),
);

export interface WorkspaceManifest {
  schemaVersion: 1;
  $schema?: string;
  workspace?: WorkspaceSettings;
  devServer?: DevSettings;
}

export interface WorkspaceSettings {
  sharedDirs?: string[];
  gitignoredFiles?: FileEntry[];
  preSetup?: Step[];
  finalize?: Step[];
  purge?: PurgeStep[];
  summary?: TextOutput;
}

export interface DevSettings {
  ports?: DevPortsConfig;
  runFiles?: FileEntry[];
  runFilesInputs?: string[] | { command: Command };
  setup?: Step[];
  servers: Server[];
  maxConcurrentDevServers?: number;
  summary?: TextOutput;
}

export interface FileEntry {
  path: string;
  source:
    | { kind: "mainWorktree"; fallback?: string }
    | { kind: "committed"; path: string }
    | { kind: "content"; content: TextOutput };
  patch?: { env: Record<string, string> } | { command: Command };
  optional?: boolean;
}

export type TextOutput = string | { command: Command };

export interface Command {
  run: string | string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Step extends Command {
  name: string;
}

export interface PurgeStep extends Step {
  continueOnError?: boolean;
}

export type Server =
  | {
      kind: "spawn";
      name: string;
      exec: Command;
      port?: string | number;
      ready: { log: string };
      error?: { log: string };
    }
  | { kind: "command"; name: string; start: Command; stop?: Command };

export interface ConfigFileLocation {
  path: string;
  exists: boolean;
}

export interface WorkspaceConfigReport {
  location: ConfigFileLocation & { in: "project" };
  schemaVersion: number | null;
  portRange: PortRange | null;
  hasDevServer: boolean;
}

/** Presence only: callers can select a location before rejecting ambiguous extensions. */
export function configFamilyExists(directory: string, family: string): boolean {
  return configVariants(directory, family).length > 0;
}

export function resolveConfigFamily(directory: string, family: string): ConfigFileLocation {
  const variants = configVariants(directory, family);
  if (variants.length > 1)
    throw new ConfigError(`Ambiguous configuration: ${variants.join(" and ")}. Keep one variant.`);
  return { path: variants[0] ?? join(directory, `${family}.json`), exists: variants.length > 0 };
}

function configVariants(directory: string, family: string): string[] {
  return ["json", "jsonc"]
    .map((ext) => join(directory, `${family}.${ext}`))
    .filter((path) => {
      try {
        return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
      } catch {
        throw new ConfigError(`Cannot inspect configuration ${path}. Check file permissions.`);
      }
    });
}

export function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Invalid ${path}: cannot read configuration. Check file permissions.`);
  }
  const errors: ParseError[] = [];
  const jsonc = path.endsWith(".jsonc");
  const tree = parseTree(text, errors, {
    disallowComments: !jsonc,
    allowTrailingComma: jsonc,
    allowEmptyContent: false,
  });
  if (errors.length > 0 || tree === undefined)
    throw new ConfigError(`Invalid ${path}: must contain valid ${jsonc ? "JSONC" : "JSON"}.`);
  // Unlike parse(), getNodeValue() preserves literal prototype-named dictionary keys.
  return getNodeValue(tree);
}

export function validateConfigSchema<T>(
  value: unknown,
  schema: object,
  label: string,
): asserts value is T {
  let validate = validators.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (validate(value)) return;
  const errors = validate.errors ?? [];
  const details = [...new Set(errors.map(schemaError))].join("; ");
  throw new ConfigError(
    `Invalid ${label}: ${details}. Check the configuration or update alignfirst for newer settings/schema versions.`,
  );
}

function schemaError(error: ErrorObject): string {
  let property = error.instancePath;
  if (error.keyword === "additionalProperties") property += `/${error.params.additionalProperty}`;
  if (error.keyword === "required") property += `/${error.params.missingProperty}`;
  // Ajv messages describe constraints, never the rejected data or environment values.
  const message =
    error.keyword === "contains" &&
    error.schemaPath === "#/properties/devServer/properties/servers/contains"
      ? "must contain at least one spawn service"
      : (error.message ?? "is invalid");
  return `${JSON.stringify(property === "" ? "/" : property)} ${message}`;
}

export function loadWorkspaceManifest(directory: string): WorkspaceManifest | undefined {
  const location = resolveConfigFamily(directory, WORKSPACE_CONFIG_FAMILY);
  if (!location.exists) return;
  return validateWorkspaceManifest(readConfigFile(location.path), location.path);
}

export function validateWorkspaceManifest(value: unknown, label: string): WorkspaceManifest {
  validateConfigSchema<WorkspaceManifest>(value, manifestSchema, label);
  const dev = value.devServer;
  if (dev?.ports !== undefined) {
    try {
      resolveDevPortsConfig(dev.ports);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw new ConfigError(`Invalid ${label}: devServer.${error.message}`);
    }
  }
  const names = new Set<string>();
  for (const [index, server] of (dev?.servers ?? []).entries()) {
    if (names.has(server.name))
      throw new ConfigError(
        `Invalid ${label}: duplicate server name at devServer.servers[${index}].name.`,
      );
    names.add(server.name);
    if (server.kind !== "spawn") continue;
    validateLogPattern(server.ready.log, label, `devServer.servers[${index}].ready.log`);
    if (server.error)
      validateLogPattern(server.error.log, label, `devServer.servers[${index}].error.log`);
    if (
      typeof server.port === "string" &&
      !dev?.ports?.declare.some(
        (entry) => (typeof entry === "string" ? entry : entry.name) === server.port,
      )
    )
      throw new ConfigError(
        `Invalid ${label}: devServer.servers[${index}].port names an undeclared port.`,
      );
  }
  const workspaceFiles = new Set(
    (value.workspace?.gitignoredFiles ?? []).map((file) => normalize(file.path)),
  );
  for (const [index, file] of (dev?.runFiles ?? []).entries()) {
    if (workspaceFiles.has(normalize(file.path)))
      throw new ConfigError(
        `Invalid ${label}: devServer.runFiles[${index}].path also occurs in workspace.gitignoredFiles.`,
      );
  }
  return value;
}

function validateLogPattern(pattern: string, label: string, field: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new ConfigError(`Invalid ${label}: ${field} must be a regular-expression source.`);
  }
}

export function readWorkspaceConfigReport(directory: string): WorkspaceConfigReport {
  const location = resolveConfigFamily(directory, WORKSPACE_CONFIG_FAMILY);
  const manifest = location.exists
    ? validateWorkspaceManifest(readConfigFile(location.path), location.path)
    : undefined;
  const ports = manifest?.devServer?.ports;
  return {
    location: { ...location, in: "project" },
    schemaVersion: manifest?.schemaVersion ?? null,
    portRange: ports === undefined ? null : { first: ports.first, last: ports.last },
    hasDevServer: manifest?.devServer !== undefined,
  };
}
