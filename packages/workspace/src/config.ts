import { lstatSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { getNodeValue, type ParseError, parseTree } from "jsonc-parser";

import { ConfigError } from "./errors.js";
import { resolveDevPortsConfig } from "./ports.js";
import type { ConfigFileLocation, EnvNumber, WorkspaceManifest } from "./workspace-config-types.js";

const validators = new WeakMap<object, ValidateFunction>();
const ajv = new Ajv({ allErrors: true, ownProperties: true });
ajv.addFormat("uri", fullFormats.uri);
ajv.addFormat("date-time", fullFormats["date-time"]);

export type {
  WorkspaceManifest,
  WorkspaceSettings,
  DevSettings,
  EnvNumber,
  FileEntry,
  TextOutput,
  Command,
  Step,
  PurgeStep,
  Server,
  ServerError,
  ConfigFileLocation,
  WorkspaceConfigReport,
} from "./workspace-config-types.js";

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

export function validateWorkspaceSettings(value: WorkspaceManifest, label: string): void {
  const dev = value.devServer;
  if (dev?.maxConcurrentDevServers !== undefined) {
    const limit = dev.maxConcurrentDevServers;
    validateLimit(typeof limit === "number" ? limit : limit.default);
    if (
      typeof limit !== "number" &&
      (!/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(limit.env) ||
        Object.keys(limit).some((key) => key !== "env" && key !== "default"))
    ) {
      throw new ConfigError("devServer.maxConcurrentDevServers: invalid environment binding.");
    }
  }
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
    if (server.error?.log !== undefined)
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
}

export function resolveDevServerLimit(
  limit: number | EnvNumber | undefined,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (limit === undefined) return;
  if (typeof limit === "number") {
    validateLimit(limit);
    return limit;
  }
  validateLimit(limit.default);
  const value = env[limit.env];
  if (value === undefined) return limit.default;
  const resolved = Number(value);
  if (value.length === 0 || /[^0-9]/.test(value) || !Number.isSafeInteger(resolved)) {
    throw new ConfigError(
      `devServer.maxConcurrentDevServers: ${limit.env} must contain a nonnegative safe decimal integer.`,
    );
  }
  return resolved;
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ConfigError("devServer.maxConcurrentDevServers must be a nonnegative safe integer.");
}

function validateLogPattern(pattern: string, label: string, field: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new ConfigError(`Invalid ${label}: ${field} must be a regular-expression source.`);
  }
}
