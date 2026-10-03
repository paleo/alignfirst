import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type } from "arktype";

import { CODING_AGENTS, type CodingAgent } from "./code/coding-agent.js";
import { errorMessage } from "./errors.js";

export const PLATFORMS = ["openclaw", "codingAgent"] as const;

const codeSchema = type({
  "+": "reject",
  agent: type.enumerated(...CODING_AGENTS),
  "models?": "string[]",
  "skipPermissions?": "boolean",
  "unset?": "string[]",
});
const configSchema = type({
  "+": "reject",
  platform: type.enumerated(...PLATFORMS),
  "projectsRoot?": "string > 0",
  code: codeSchema,
});

export type Platform = (typeof PLATFORMS)[number];

export interface AligndevConfig {
  // The config file path, for error messages.
  path: string;
  platform: Platform;
  projectsRoot?: ProjectsRoot;
  code: CodeConfig;
}

export interface ProjectsRoot {
  // Resolved absolute path.
  path: string;
  // The value as written, e.g. `~/projects`, shown in guides.
  written: string;
}

export interface CodeConfig {
  agent: CodingAgent;
  models?: string[];
  skipPermissions: boolean;
  unset: string[];
}

// An absent file is a normal state: a machine where aligndev is not configured.
export function loadConfig(home: string): AligndevConfig | undefined {
  const path = configPath(home);
  if (!existsSync(path)) return;
  const value = parseConfigFile(path);
  return {
    path,
    platform: value.platform,
    ...(value.projectsRoot === undefined
      ? {}
      : { projectsRoot: resolveProjectsRoot(value.projectsRoot, home, path) }),
    code: {
      agent: value.code.agent,
      ...(value.code.models === undefined ? {} : { models: value.code.models }),
      skipPermissions: value.code.skipPermissions ?? false,
      unset: value.code.unset ?? [],
    },
  };
}

function configPath(home: string): string {
  return join(home, ".config", "alignfirst", "aligndev.config.json");
}

function parseConfigFile(path: string): typeof configSchema.infer {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  const config = configSchema(value);
  if (config instanceof type.errors) throw invalidConfig(path, config.summary.split("\n", 1)[0]);
  return config;
}

function invalidConfig(path: string, detail: string): Error {
  return new Error(`Error: invalid aligndev config ${path}: ${detail}`);
}

function resolveProjectsRoot(written: string, home: string, path: string): ProjectsRoot {
  if (written.startsWith("~/")) return { path: join(home, written.slice(2)), written };
  return { path: isAbsolute(written) ? written : resolve(dirname(path), written), written };
}

export function missingConfigMessage(home: string): string {
  return (
    `Error: no aligndev config at ${configPath(home)}. Create it with "platform" ` +
    `(${PLATFORMS.join(" or ")}) and "code.agent" (${CODING_AGENTS.join(" or ")}).`
  );
}

export function requireProjectsRoot(config: AligndevConfig): ProjectsRoot {
  if (config.projectsRoot !== undefined) return config.projectsRoot;
  throw new Error(`Error: projectsRoot is missing from the aligndev config ${config.path}.`);
}
