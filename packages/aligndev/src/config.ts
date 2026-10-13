import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CODING_AGENTS, type CodingAgent, detectCodingAgents } from "./code/coding-agent.js";
import { resolveModels } from "./code/models.js";
import { errorMessage } from "./errors.js";
import {
  arrayOf,
  boolean,
  literal,
  nonEmptyString,
  object,
  optional,
  parseShape,
  string,
} from "./json-shape.js";

export const PLATFORMS = ["openclaw", "codingAgent"] as const;

const codeShape = object<CodeConfigFile>({
  agent: optional(literal(...CODING_AGENTS)),
  model: optional(nonEmptyString),
  models: optional(arrayOf(string)),
  skipPermissions: optional(boolean),
  unset: optional(arrayOf(string)),
});
const configShape = object<ConfigFile>({
  platform: optional(literal(...PLATFORMS)),
  projectsRoot: optional(nonEmptyString),
  code: optional(codeShape),
});

export type Platform = (typeof PLATFORMS)[number];

// The config file with its defaults applied. Without `code.agent`, the coding agent is unknown
// until `resolveCodeConfig` detects it.
export interface LoadedConfig {
  // The config file path, for error messages. The file may be absent.
  path: string;
  platform: Platform;
  projectsRoot?: ProjectsRoot;
  code: LoadedCodeConfig;
}

export interface ProjectsRoot {
  // Resolved absolute path.
  path: string;
  // The value as written, e.g. `~/projects`, shown in guides.
  written: string;
}

export interface LoadedCodeConfig {
  agent?: CodingAgent;
  model?: string;
  models?: string[];
  skipPermissions: boolean;
  unset: string[];
}

export interface CodeConfig extends LoadedCodeConfig {
  agent: CodingAgent;
}

interface ConfigFile {
  platform?: Platform;
  projectsRoot?: string;
  code?: CodeConfigFile;
}

interface CodeConfigFile {
  agent?: CodingAgent;
  // Model used when `--model` is omitted on a new session.
  model?: string;
  models?: string[];
  skipPermissions?: boolean;
  unset?: string[];
}

// An absent file is a normal state: every key takes its default. A leftover file under the old
// name is an error, so a missed rename never silently drops the user's settings.
export function loadConfig(home: string): LoadedConfig {
  const path = join(home, ".alignfirst", "settings.json");
  const value = existsSync(path) ? parseConfigFile(path) : absentConfig(home);
  const code = value.code ?? {};
  return {
    path,
    platform: value.platform ?? "codingAgent",
    ...(value.projectsRoot === undefined
      ? {}
      : { projectsRoot: resolveProjectsRoot(value.projectsRoot, home, path) }),
    code: {
      ...(code.agent === undefined ? {} : { agent: code.agent }),
      ...(code.model === undefined ? {} : { model: code.model }),
      ...(code.models === undefined ? {} : { models: code.models }),
      skipPermissions: code.skipPermissions ?? false,
      unset: code.unset ?? [],
    },
  };
}

function absentConfig(home: string): ConfigFile {
  if (existsSync(join(home, ".alignfirst", "aligndev.config.json"))) {
    throw new Error(
      "Error: ~/.alignfirst/aligndev.config.json was renamed: move it to ~/.alignfirst/settings.json",
    );
  }
  return {};
}

function parseConfigFile(path: string): ConfigFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  return parseShape(configShape, value, (detail) => invalidConfig(path, detail));
}

function invalidConfig(path: string, detail: string): Error {
  return new Error(`Error: invalid aligndev config ${path}: ${detail}`);
}

function resolveProjectsRoot(written: string, home: string, path: string): ProjectsRoot {
  if (written.startsWith("~/")) return { path: join(home, written.slice(2)), written };
  return { path: isAbsolute(written) ? written : resolve(dirname(path), written), written };
}

export function resolveCodeConfig(config: LoadedConfig, env: NodeJS.ProcessEnv): CodeConfig {
  const code = { ...config.code, agent: resolveAgent(config, env) };
  checkDefaultModel(code, config.path);
  return code;
}

// The configured `code.agent` wins; otherwise, the coding agent that runs aligndev.
function resolveAgent(config: LoadedConfig, env: NodeJS.ProcessEnv): CodingAgent {
  const { agent } = config.code;
  if (agent !== undefined) return agent;
  const detected = detectCodingAgents(env);
  if (detected.length === 1) return detected[0];
  const problem =
    detected.length === 0
      ? "no coding agent detected: run aligndev from Claude Code or Codex, or set"
      : "both Claude Code and Codex detected: set";
  throw new Error(
    `Error: ${problem} "code.agent" (${CODING_AGENTS.join(" or ")}) in ${config.path}.`,
  );
}

function checkDefaultModel(code: CodeConfig, path: string): void {
  if (code.model === undefined) return;
  const models = resolveModels(code.agent, code.models);
  if (models.includes(code.model)) return;
  throw new Error(`Error: code.model must be one of: ${models.join(", ")}, in ${path}.`);
}

export function requireProjectsRoot(config: LoadedConfig): ProjectsRoot {
  if (config.projectsRoot !== undefined) return config.projectsRoot;
  throw new Error(`Error: projectsRoot is missing from the aligndev config ${config.path}.`);
}
