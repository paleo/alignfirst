import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type } from "arktype";

import { AlprojectError } from "./errors.js";
import { canonicalizeParentPaths, resolveConfiguredPath } from "./paths.js";

export const CONFIG_FILENAME = ".alproject.json";

const configSchema = type({
  "+": "reject",
  firstPort: "1 <= number.integer <= 65535",
  lastPort: "1 <= number.integer <= 65535",
  "projectParents?": "(string > 0)[] > 0",
  root: "string > 0",
});

type ConfigFile = typeof configSchema.infer;

export interface AlprojectConfig {
  configPath: string;
  firstPort: number;
  lastPort: number;
  projectParents: string[];
  root: string;
}

export function readConfig(home: string): AlprojectConfig {
  const configPath = join(home, CONFIG_FILENAME);
  const configFile = readConfigFile(configPath);
  const root = resolveConfigPath(configFile.root, home, configPath, "root");
  const configuredParents = configFile.projectParents ?? [configFile.root];
  const projectParents = resolveConfigParents(configuredParents, home, configPath);

  if (configFile.firstPort > configFile.lastPort) {
    throw configurationError(configPath, "firstPort must not exceed lastPort");
  }

  assertAccessibleDirectory(root, configPath, "root");
  for (const parent of projectParents) {
    assertAccessibleDirectory(parent, configPath, "project parent");
  }

  return {
    configPath,
    firstPort: configFile.firstPort,
    lastPort: configFile.lastPort,
    projectParents,
    root,
  };
}

export function readConfigIfPresent(home: string): AlprojectConfig | undefined {
  const configPath = join(home, CONFIG_FILENAME);
  try {
    statSync(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new AlprojectError(
      "configuration",
      `Cannot inspect configuration file ${configPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return readConfig(home);
}

function readConfigFile(configPath: string): ConfigFile {
  const rawConfig = readJsonFile(configPath, "configuration");
  const config = configSchema(rawConfig);
  if (config instanceof type.errors) {
    throw configurationError(configPath, config.summary);
  }
  return config;
}

function readJsonFile(path: string, label: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new AlprojectError(
      "configuration",
      `Cannot read ${label} file ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AlprojectError(
      "configuration",
      `Invalid JSON in ${label} file ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function resolveConfigPath(path: string, home: string, configPath: string, field: string): string {
  try {
    return resolveConfiguredPath(path, home);
  } catch (error) {
    throw configurationError(configPath, `${field}: ${errorMessage(error)}`, error);
  }
}

function resolveConfigParents(paths: string[], home: string, configPath: string): string[] {
  try {
    return canonicalizeParentPaths(paths, home);
  } catch (error) {
    throw configurationError(configPath, `projectParents: ${errorMessage(error)}`, error);
  }
}

function assertAccessibleDirectory(path: string, configPath: string, field: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error("path is not a directory");
    }
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw configurationError(
      configPath,
      `${field} directory is missing or inaccessible: ${path} (${errorMessage(error)})`,
      error,
    );
  }
}

function configurationError(path: string, detail: string, cause?: unknown): AlprojectError {
  return new AlprojectError("configuration", `Invalid configuration ${path}: ${detail}`, { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
