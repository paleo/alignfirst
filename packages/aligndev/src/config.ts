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
const quotaShape = object<QuotaSettings>(
  {
    source: literal("claude", "codex", "none"),
    configDir: optional(directoryValue),
    env: optional(environmentShape),
    unset: optional(arrayOf(environmentName)),
  },
  warnUnknownSetting,
);
const profileShape = object<CodingProfile>(
  {
    agent: literal(...CODING_AGENTS),
    default: optional(boolean),
    configDir: optional(directoryValue),
    defaultModel: optional(nonblankString),
    models: optional(arrayOf(nonblankString)),
    modelAliases: optional(record(nonblankString, nonblankString)),
    skipPermissions: optional(boolean),
    env: optional(environmentShape),
    unset: optional(arrayOf(environmentName)),
    quota: optional(quotaShape),
  },
  warnUnknownSetting,
);
const codeShape = object<CodeSettings>(
  {
    profile: optional(nonblankString),
    profiles: optional(record(profileShape, nonblankString)),
  },
  warnUnknownSetting,
);
const configShape = object<ConfigFile>(
  {
    platform: optional(literal(...PLATFORMS)),
    projectsRoot: optional(nonEmptyString),
    code: optional(codeShape),
  },
  warnUnknownSetting,
);
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
  profiles?: Record<string, CodingProfile>;
}

export interface CodingProfile {
  agent: CodingAgent;
  default?: boolean;
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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw invalidConfig(path, errorMessage(error));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidConfig(path, "must contain valid JSON");
  }
  return parseShape(configShape, value, (detail) => invalidConfig(path, detail));
}

function warnUnknownSetting(path: string, key: string): void {
  const quoted = JSON.stringify(key).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
  const field = /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path === "" ? "" : `${path}.`}${key}`
    : `${path === "" ? "settings" : path}[${quoted}]`;
  let migration = "Remove it or check its spelling.";
  if (path === "code" && key === "defaultProfiles") {
    migration =
      "code.defaultProfiles is retired: manually move each needed preference to its referenced " +
      "matching-agent profile's default: true (omit singleton flags), remove the map and " +
      "keep profile names unchanged. See " +
      "https://github.com/paleo/alignfirst/blob/main/skills/alignfirst-setup-guide/" +
      "references/alignfirst-upgrade.md#convert-aligndev-profile-defaults";
  } else if (path === "code" && RETIRED_CODE_KEYS.includes(key)) {
    migration =
      "Retired launch setting: move it into code.profiles and select one with code.profile " +
      "(manual conversion required).";
  }
  console.warn(`Warning: ignoring unknown aligndev setting ${field}. ${migration}`);
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
  } else if (selection.recorded === null) {
    profile = { agent: detectAgent(config, env) };
  } else {
    const automatic = resolveAutomaticProfile(config, env);
    profile = automatic.profile;
    effectiveName = automatic.name;
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
  for (const agent of CODING_AGENTS) {
    const names = Object.entries(config.code.profiles ?? {})
      .filter(([, profile]) => profile.agent === agent && profile.default === true)
      .map(([name]) => JSON.stringify(name));
    if (names.length > 1)
      throw invalidConfig(
        config.path,
        `multiple default: true profiles for ${agent}: ${names.join(", ")}; ` +
          `leave only one default: true for ${agent}`,
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

function resolveAutomaticProfile(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
): { profile: CodingProfile; name?: string } {
  const detected = detectCodingAgents(env);
  const profiles = Object.entries(config.code.profiles ?? {});
  if (detected.length === 0 && profiles.length === 1) {
    const [name, profile] = profiles[0];
    return { name, profile };
  }
  if (detected.length !== 1) throw selectionRequired(config, detected);
  const agent = detected[0];
  const matching = profiles.filter(([, profile]) => profile.agent === agent);
  if (matching.length === 0) return { profile: { agent } };
  const selected =
    matching.length === 1 ? matching[0] : matching.find(([, p]) => p.default === true);
  if (selected !== undefined) return { name: selected[0], profile: selected[1] };
  throw invalidConfig(
    config.path,
    `multiple profiles for detected ${agent}: ${matching.map(([name]) => JSON.stringify(name)).join(", ")}; ` +
      "select --profile, a project registry profile, code.profile, or set one matching " +
      "profile's default: true",
  );
}

function detectAgent(config: LoadedConfig, env: NodeJS.ProcessEnv): CodingAgent {
  const detected = detectCodingAgents(env);
  if (detected.length === 1) return detected[0];
  throw selectionRequired(config, detected);
}

function selectionRequired(config: LoadedConfig, detected: CodingAgent[]): Error {
  const problem =
    detected.length === 0
      ? `no coding agent detected (${CODING_AGENTS.join(", ")})`
      : `multiple coding agents detected (${detected.join(", ")})`;
  return new Error(
    `Error: ${problem}: select --profile, a project registry profile, or set "code.profile" in ${config.path}.`,
  );
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
