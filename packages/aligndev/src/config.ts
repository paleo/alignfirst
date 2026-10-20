import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CODING_AGENTS,
  type CodingAgent,
  createAgentAdapter,
  detectCodingAgents,
} from "./code/coding-agent.js";
import { resolveModels } from "./code/models.js";
import { buildAgentEnv } from "./code/run-agent.js";
import { errorMessage } from "./errors.js";
import {
  arrayOf,
  boolean,
  literal,
  matching,
  nonblankString,
  nonEmptyString,
  nulFreeString,
  object,
  optional,
  parseShape,
  record,
} from "./json-shape.js";
import type { AligndevProjectSettings } from "./project/layout.js";

export const PLATFORMS = ["openclaw", "codingAgent"] as const;
export const CONFIG_DIRECTORY_VARIABLES = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
} as const;

const environmentName = matching(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentShape = record(nulFreeString, environmentName);
const quotaShape = object<QuotaSettings>({
  source: literal("claude", "codex", "none"),
  configDir: optional(directoryValue),
  env: optional(environmentShape),
  unset: optional(arrayOf(environmentName)),
});
const profileShape = object<CodingProfile>({
  agent: literal(...CODING_AGENTS),
  configDir: optional(directoryValue),
  defaultModel: optional(nonblankString),
  models: optional(arrayOf(nonblankString)),
  modelAliases: optional(record(nonblankString, nonblankString)),
  skipPermissions: optional(boolean),
  env: optional(environmentShape),
  unset: optional(arrayOf(environmentName)),
  quota: optional(quotaShape),
});
const codeShape = object<CodeSettings>({
  profile: optional(nonblankString),
  defaultProfiles: optional(
    object<Partial<Record<CodingAgent, string>>>({
      claude: optional(nonblankString),
      codex: optional(nonblankString),
      pi: optional(nonblankString),
    }),
  ),
  profiles: optional(record(profileShape, nonblankString)),
});
const configShape = object<ConfigFile>({
  platform: optional(literal(...PLATFORMS)),
  projectsRoot: optional(nonEmptyString),
  code: optional(codeShape),
});
const RETIRED_CODE_KEYS = ["agent", "defaultModel", "models", "skipPermissions", "unset"];

export type Platform = (typeof PLATFORMS)[number];

export interface LoadedConfig {
  path: string;
  platform: Platform;
  projectsRoot?: ProjectsRoot;
  code: CodeSettings;
}

export interface ProjectsRoot {
  path: string;
  written: string;
}

export interface CodeSettings {
  profile?: string;
  defaultProfiles?: Partial<Record<CodingAgent, string>>;
  profiles?: Record<string, CodingProfile>;
}

export interface CodingProfile {
  agent: CodingAgent;
  configDir?: string;
  defaultModel?: string;
  models?: string[];
  modelAliases?: Record<string, string>;
  skipPermissions?: boolean;
  env?: Record<string, string>;
  unset?: string[];
  quota?: QuotaSettings;
}

export interface QuotaSettings {
  source: "claude" | "codex" | "none";
  configDir?: string;
  env?: Record<string, string>;
  unset?: string[];
}

export interface CodeConfig extends CodingProfile {
  profile: string | null;
  skipPermissions: boolean;
  unset: string[];
  childEnv: NodeJS.ProcessEnv;
}

interface ConfigFile {
  platform?: Platform;
  projectsRoot?: string;
  code?: CodeSettings;
}

export function loadConfig(home: string): LoadedConfig {
  const path = join(home, ".alignfirst", "aligndev.settings.json");
  const value = existsSync(path) ? parseConfigFile(path) : absentConfig(home);
  const code = value.code ?? {};
  for (const [name, profile] of Object.entries(code.profiles ?? {})) {
    const field = `code.profiles[${JSON.stringify(name)}]`;
    validateEnvironment(profile, profile.agent, field, path);
    if (profile.configDir !== undefined)
      profile.configDir = resolvePath(profile.configDir, home, path);
    if (profile.quota !== undefined) {
      const quota = profile.quota;
      if (quota.source === "none") {
        if (Object.keys(quota).some((key) => key !== "source")) {
          throw invalidConfig(path, `${field}.quota with source none accepts no other options`);
        }
      } else {
        validateEnvironment(quota, quota.source, `${field}.quota`, path);
      }
      if (quota.configDir !== undefined) quota.configDir = resolvePath(quota.configDir, home, path);
    }
  }
  return {
    path,
    platform: value.platform ?? "codingAgent",
    ...(value.projectsRoot === undefined
      ? {}
      : {
          projectsRoot: {
            path: resolvePath(value.projectsRoot, home, path),
            written: value.projectsRoot,
          },
        }),
    code,
  };
}

function absentConfig(home: string): ConfigFile {
  if (existsSync(join(home, ".alignfirst", "aligndev.config.json"))) {
    throw new Error(
      "Error: ~/.alignfirst/aligndev.config.json was renamed: " +
        "move it to ~/.alignfirst/aligndev.settings.json",
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
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "object" &&
    value.code !== null
  ) {
    const retired = RETIRED_CODE_KEYS.find((key) => Object.hasOwn(value.code ?? {}, key));
    if (retired !== undefined) {
      throw invalidConfig(
        path,
        `code.${retired} is retired: move launch settings into ` +
          "code.profiles and select one with code.profile (manual conversion required)",
      );
    }
  }
  return parseShape(configShape, value, (detail) => invalidConfig(path, detail));
}

function invalidConfig(path: string, detail: string): Error {
  return new Error(`Error: invalid aligndev config ${path}: ${detail}`);
}

function directoryValue(value: unknown, path: string): string {
  nonblankString(value, path);
  return nulFreeString(value, path);
}

function validateEnvironment(
  settings: { env?: Record<string, string>; unset?: string[]; configDir?: string },
  agent: CodingAgent,
  field: string,
  path: string,
): void {
  for (const name of settings.unset ?? []) {
    if (Object.hasOwn(settings.env ?? {}, name)) {
      throw invalidConfig(path, `${field}.unset overlaps ${field}.env for ${name}`);
    }
  }
  const variable = CONFIG_DIRECTORY_VARIABLES[agent];
  if (
    settings.configDir !== undefined &&
    (Object.hasOwn(settings.env ?? {}, variable) || settings.unset?.includes(variable))
  ) {
    throw invalidConfig(path, `${field}.configDir conflicts with env/unset for ${variable}`);
  }
}

function resolvePath(written: string, home: string, path: string): string {
  if (written.startsWith("~/")) return join(home, written.slice(2));
  return isAbsolute(written) ? written : resolve(dirname(path), written);
}

export type QuotaSource = "claude" | "codex";

export type ResolvedQuota = { source: "none" } | { source: QuotaSource; env: NodeJS.ProcessEnv };

export function resolveQuotaConfig(code: CodeConfig, callerEnv: NodeJS.ProcessEnv): ResolvedQuota {
  const quota = code.quota;
  if (quota?.source === "none") return { source: "none" };
  if (quota === undefined) {
    if (code.agent === "pi") {
      throw new Error(
        "Pi account quota is unsupported without explicit configuration: " +
          "set quota.source to claude or codex with its native configDir, or none to disable it.",
      );
    }
    return { source: code.agent, env: code.childEnv };
  }
  const overrides = { ...quota.env };
  if (quota.configDir !== undefined)
    overrides[CONFIG_DIRECTORY_VARIABLES[quota.source]] = quota.configDir;
  return {
    source: quota.source,
    env: buildAgentEnv(callerEnv, quota.unset ?? [], overrides),
  };
}

export interface ProfileSelection {
  project?: AligndevProjectSettings | null;
  explicit?: string;
  recorded?: string | null;
}

export function resolveCodeConfig(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  selection: ProfileSelection = {},
): CodeConfig {
  validateReferences(config);
  const name =
    selection.explicit ?? selection.project?.profile ?? selection.recorded ?? config.code.profile;
  let profile: CodingProfile;
  let effectiveName = name;
  if (name !== undefined) {
    profile = referencedProfile(config, name, "selected profile");
  } else {
    const agent = detectAgent(config, env);
    effectiveName = config.code.defaultProfiles?.[agent];
    profile =
      effectiveName === undefined
        ? { agent }
        : referencedProfile(config, effectiveName, "defaultProfiles");
  }
  checkDefaultModel(profile, config.path, effectiveName);
  const overrides = { ...profile.env };
  if (profile.configDir !== undefined)
    overrides[CONFIG_DIRECTORY_VARIABLES[profile.agent]] = profile.configDir;
  return {
    ...profile,
    profile: effectiveName ?? null,
    skipPermissions: profile.skipPermissions ?? false,
    unset: profile.unset ?? [],
    childEnv: buildAgentEnv(
      env,
      profile.unset ?? [],
      overrides,
      createAgentAdapter(profile.agent).env,
    ),
  };
}

function validateReferences(config: LoadedConfig): void {
  if (config.code.profile !== undefined)
    referencedProfile(config, config.code.profile, "code.profile");
  for (const [agent, name] of Object.entries(config.code.defaultProfiles ?? {})) {
    const profile = referencedProfile(config, name, `code.defaultProfiles.${agent}`);
    if (profile.agent !== agent)
      throw invalidConfig(
        config.path,
        `code.defaultProfiles.${agent} references a ${profile.agent} profile`,
      );
  }
}

function referencedProfile(config: LoadedConfig, name: string, field: string): CodingProfile {
  const profile = Object.hasOwn(config.code.profiles ?? {}, name)
    ? config.code.profiles?.[name]
    : undefined;
  if (name.trim() === "" || profile === undefined) {
    throw invalidConfig(
      config.path,
      `${field} references missing profile ${JSON.stringify(name)}; define it in code.profiles or select another --profile`,
    );
  }
  return profile;
}

function detectAgent(config: LoadedConfig, env: NodeJS.ProcessEnv): CodingAgent {
  const detected = detectCodingAgents(env);
  if (detected.length === 1) return detected[0];
  const problem =
    detected.length === 0
      ? `no coding agent detected (${CODING_AGENTS.join(", ")})`
      : `multiple coding agents detected (${detected.join(", ")})`;
  throw new Error(`Error: ${problem}: select --profile or set "code.profile" in ${config.path}.`);
}

function checkDefaultModel(code: CodingProfile, path: string, profile: string | undefined): void {
  if (code.defaultModel === undefined) return;
  const models = resolveModels(code.agent, code.models, code.modelAliases);
  if (models === undefined || models.includes(code.defaultModel)) return;
  throw invalidConfig(
    path,
    `code.profiles[${JSON.stringify(profile)}].defaultModel must be one of: ${models.join(", ")}`,
  );
}

export function requireProjectsRoot(config: LoadedConfig): ProjectsRoot {
  if (config.projectsRoot !== undefined) return config.projectsRoot;
  throw new Error(`Error: projectsRoot is missing from the aligndev config ${config.path}.`);
}
