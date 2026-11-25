import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  ASSISTANT_HARNESS_VARIABLE,
  type AssistantHarness,
  HARNESSES,
  resolveAssistantHarness,
} from "./assistant-harness.js";
import { CODING_AGENTS, type CodingAgent, createAgentAdapter } from "./code/coding-agent.js";
import { resolveEfforts } from "./code/efforts.js";
import { resolveModels } from "./code/models.js";
import { buildAgentEnv } from "./code/run-agent.js";
import { errorMessage } from "./errors.js";
import {
  arrayOf,
  boolean,
  type Check,
  isPlainObject,
  literal,
  matching,
  nonblankString,
  nonEmptyString,
  nulFreeString,
  object,
  optional,
  parseShape,
  record,
  rejectField,
} from "./json-shape.js";
import type { AligndevProjectSettings } from "./project/layout.js";

// Antigravity has one native store and one account per OS user: no variable moves them.
export const CONFIG_DIRECTORY_VARIABLES: Readonly<Record<CodingAgent, string | undefined>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  pi: "PI_CODING_AGENT_DIR",
  agy: undefined,
};

const environmentName = matching(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentShape = record(nulFreeString, environmentName);
const RETIRED_CODE_KEYS = ["agent", "defaultModel", "models", "skipPermissions", "unset"];
// Recognized keys of a coding-agent profile that an openclaw profile rejects.
const CODING_ONLY_PROFILE_KEYS = [
  "default",
  "configDir",
  "defaultModel",
  "models",
  "modelAliases",
  "defaultEffort",
  "efforts",
  "skipPermissions",
  "env",
  "unset",
  "quota",
];

export interface LoadedConfig {
  path: string;
  projectsRoot?: ProjectsRoot;
  code: CodeSettings;
}

export interface ProjectsRoot {
  path: string;
  written: string;
}

export interface CodeSettings {
  fallbackProfile?: string;
  profiles?: Record<string, Profile>;
}

export type Profile = CodingProfile | OpenclawProfile;

export interface CodingProfile {
  harness: CodingAgent;
  defaultAgentProfile?: string;
  disabled?: boolean;
  default?: boolean;
  configDir?: string | null;
  defaultModel?: string;
  models?: string[];
  modelAliases?: Record<string, string>;
  defaultEffort?: string;
  efforts?: string[];
  skipPermissions?: boolean;
  env?: Record<string, string>;
  unset?: string[];
  quota?: QuotaSettings;
}

// Describes an OpenClaw assistant; it launches nothing.
export interface OpenclawProfile {
  harness: "openclaw";
  defaultAgentProfile: string;
  disabled?: boolean;
}

export interface QuotaSettings {
  source: "claude" | "codex" | "agy" | "none";
  configDir?: string | null;
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
  projectsRoot?: string;
  code?: CodeSettings;
}

/** `alignfirst` is the caller's alignfirst command form, cited by migration hints. */
export function loadConfig(home: string, alignfirst: string): LoadedConfig {
  const path = join(home, ".alignfirst", "aligndev.settings.json");
  const value = existsSync(path) ? parseConfigFile(path, alignfirst) : absentConfig(home);
  const code = value.code ?? {};
  for (const [name, profile] of Object.entries(code.profiles ?? {})) {
    if (profile.harness === "openclaw") continue;
    const field = `code.profiles[${JSON.stringify(name)}]`;
    validateEnvironment(profile, profile.harness, field, path);
    checkDefaultEffort(profile, field, path);
    if (typeof profile.configDir === "string")
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
      if (typeof quota.configDir === "string")
        quota.configDir = resolvePath(quota.configDir, home, path);
    }
  }
  return {
    path,
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

function parseConfigFile(path: string, alignfirst: string): ConfigFile {
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
  return parseShape(configShape(alignfirst), value, (detail) => invalidConfig(path, detail));
}

function configShape(alignfirst: string): Check<ConfigFile> {
  const warn = (path: string, key: string) => warnUnknownSetting(path, key, alignfirst);
  const codeShape = object<CodeSettings>(
    {
      fallbackProfile: optional(nonblankString),
      profiles: optional(record(profileShape(warn), nonblankString)),
    },
    warn,
  );
  return object<ConfigFile>(
    {
      projectsRoot: optional(nonEmptyString),
      code: optional(codeShape),
    },
    warn,
  );
}

// Dispatches on `harness`: an openclaw profile accepts only its own keys.
function profileShape(warn: (path: string, key: string) => void): Check<Profile> {
  const quotaShape = object<QuotaSettings>(
    {
      source: literal("claude", "codex", "agy", "none"),
      configDir: optional(directoryValue),
      env: optional(environmentShape),
      unset: optional(arrayOf(environmentName)),
    },
    warn,
  );
  const codingShape = object<CodingProfile>(
    {
      harness: literal(...CODING_AGENTS),
      defaultAgentProfile: optional(nonblankString),
      disabled: optional(boolean),
      default: optional(boolean),
      configDir: optional(directoryValue),
      defaultModel: optional(nonblankString),
      models: optional(arrayOf(nonblankString)),
      modelAliases: optional(record(nonblankString, nonblankString)),
      defaultEffort: optional(nonblankString),
      efforts: optional(arrayOf(nonblankString)),
      skipPermissions: optional(boolean),
      env: optional(environmentShape),
      unset: optional(arrayOf(environmentName)),
      quota: optional(quotaShape),
    },
    warn,
  );
  const openclawShape = object<OpenclawProfile>(
    {
      harness: literal("openclaw"),
      defaultAgentProfile: nonblankString,
      disabled: optional(boolean),
    },
    warn,
  );
  return (raw, path, warningPath = path) => {
    if (!isPlainObject(raw)) return codingShape(raw, path, warningPath);
    const legacy = !Object.hasOwn(raw, "harness") && Object.hasOwn(raw, "agent");
    const value = legacy ? mapLegacyAgent(raw, warningPath) : raw;
    const harness = "harness" in value ? value.harness : undefined;
    if (harness === "openclaw") {
      for (const key of CODING_ONLY_PROFILE_KEYS) {
        if (Object.hasOwn(value, key))
          rejectField(
            path,
            key,
            "be removed: an openclaw profile accepts only harness, defaultAgentProfile and disabled",
          );
      }
      return openclawShape(value, path, warningPath);
    }
    if (!HARNESSES.some((item) => item === harness)) {
      rejectField(path, legacy ? "agent" : "harness", `be one of ${HARNESSES.join(", ")}`);
    }
    return codingShape(value, path, warningPath);
  };
}

// One-off exception to the retired-keys policy: the pre-`harness` key still reads, in memory only.
function mapLegacyAgent(
  profile: Record<string, unknown>,
  warningPath: string,
): Record<string, unknown> {
  console.warn(
    `Warning: deprecated aligndev setting ${warningPath}.agent: read as "harness". ` +
      'Rename "agent" to "harness".',
  );
  const { agent, ...rest } = profile;
  return { ...rest, harness: agent };
}

function warnUnknownSetting(path: string, key: string, alignfirst: string): void {
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
  if (path === "" && key === "platform") {
    migration =
      "platform is retired: the assistant's harness is resolved at each invocation " +
      `(see ${ASSISTANT_HARNESS_VARIABLE}). Remove it.`;
  } else if (path === "" && key === "portRange") {
    migration =
      "portRange is retired: pass the bounds to `project free-ports --within <first>..<last>`, " +
      "and state a deployment's range in its own instructions. Remove it.";
  } else if (path === "code" && key === "profile") {
    migration =
      "code.profile is retired: set defaultAgentProfile on the assistant's profile, " +
      "or code.fallbackProfile. Remove it.";
  } else if (path === "code.profiles[<entry>]" && key === "agent") {
    migration = 'The profile key "agent" was renamed to "harness". Remove it.';
  } else if (path === "code" && key === "defaultProfiles") {
    migration =
      "code.defaultProfiles is retired: manually move each needed preference to its referenced " +
      "matching-agent profile's default: true (omit singleton flags), remove the map and " +
      'keep profile names unchanged. See "Convert AlignDev Profile Defaults" in ' +
      `\`${alignfirst} setup guide upgrade\`.`;
  } else if (path === "code" && RETIRED_CODE_KEYS.includes(key)) {
    migration =
      "Retired launch setting: move it into a profile under code.profiles, then select that " +
      "profile with the assistant profile's defaultAgentProfile or code.fallbackProfile " +
      "(manual conversion required).";
  }
  console.warn(`Warning: ignoring unknown aligndev setting ${field}. ${migration}`);
}

function invalidConfig(path: string, detail: string): Error {
  return new Error(`Error: invalid aligndev config ${path}: ${detail}`);
}

function directoryValue(value: unknown, path: string): string | null {
  if (value === null) return null;
  nonblankString(value, path);
  return nulFreeString(value, path);
}

function validateEnvironment(
  settings: CodingProfile | QuotaSettings,
  agent: CodingAgent,
  field: string,
  path: string,
): void {
  for (const name of settings.unset ?? []) {
    if (Object.hasOwn(settings.env ?? {}, name)) {
      throw invalidConfig(path, `${field}.unset overlaps ${field}.env for ${name}`);
    }
  }
  if (settings.configDir === undefined) return;
  const variable = CONFIG_DIRECTORY_VARIABLES[agent];
  if (variable === undefined) {
    throw invalidConfig(
      path,
      `${field}.configDir is not supported for ${agent}: Antigravity has one native store and ` +
        "one account per OS user; remove it",
    );
  }
  if (Object.hasOwn(settings.env ?? {}, variable) || settings.unset?.includes(variable)) {
    throw invalidConfig(path, `${field}.configDir conflicts with env/unset for ${variable}`);
  }
}

function resolvePath(written: string, home: string, path: string): string {
  if (written.startsWith("~/")) return join(home, written.slice(2));
  return isAbsolute(written) ? written : resolve(dirname(path), written);
}

export type QuotaSource = "claude" | "codex" | "agy";

export type ResolvedQuota = { source: "none" } | { source: QuotaSource; env: NodeJS.ProcessEnv };

export function resolveQuotaConfig(code: CodeConfig, callerEnv: NodeJS.ProcessEnv): ResolvedQuota {
  const quota = code.quota;
  if (quota?.source === "none") return { source: "none" };
  if (quota === undefined) {
    if (code.harness === "pi") {
      throw new Error(
        "Pi account quota is unsupported without explicit configuration: " +
          "set quota.source to claude, codex or agy, or none to disable it.",
      );
    }
    return { source: code.harness, env: code.childEnv };
  }
  return {
    source: quota.source,
    env: buildNativeEnv(callerEnv, quota, quota.source),
  };
}

function buildNativeEnv(
  callerEnv: NodeJS.ProcessEnv,
  settings: CodingProfile | QuotaSettings,
  agent: CodingAgent,
  required: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const variable = CONFIG_DIRECTORY_VARIABLES[agent];
  const overrides = { ...settings.env };
  const unset = settings.unset ?? [];
  if (variable === undefined) return buildAgentEnv(callerEnv, unset, overrides, required);
  if (typeof settings.configDir === "string") overrides[variable] = settings.configDir;
  const removals = settings.configDir === null ? [...unset, variable] : unset;
  return buildAgentEnv(callerEnv, removals, overrides, required);
}

export interface ProfileSelection {
  project?: AligndevProjectSettings | null;
  explicit?: string;
  recorded?: string | null;
}

export interface NamedProfile<T extends Profile = Profile> {
  name: string;
  profile: T;
}

export function resolveCodeConfig(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  selection: ProfileSelection = {},
): CodeConfig {
  const assistant = resolveAssistantHarness(env);
  validateReferences(config);
  const { name, profile } = selectProfile(config, env, assistant, selection);
  checkDefaultModel(profile, config.path, name);
  return {
    ...profile,
    profile: name ?? null,
    skipPermissions: profile.skipPermissions ?? false,
    unset: profile.unset ?? [],
    childEnv: buildNativeEnv(
      env,
      profile,
      profile.harness,
      createAgentAdapter(profile.harness).env,
    ),
  };
}

function validateReferences(config: LoadedConfig): void {
  const enabled = enabledProfiles(config);
  const coding = enabled.filter(isCodingProfile);
  for (const agent of CODING_AGENTS) {
    const defaults = coding.filter(
      ({ profile }) => profile.harness === agent && profile.default === true,
    );
    if (defaults.length > 1)
      throw invalidConfig(
        config.path,
        `multiple default: true profiles for ${agent}: ${quotedNames(defaults)}; ` +
          `leave only one default: true for ${agent}`,
      );
  }
  const openclaw = enabled.filter(isOpenclawProfile);
  if (openclaw.length > 1)
    throw invalidConfig(
      config.path,
      `multiple enabled openclaw profiles: ${quotedNames(openclaw)}; keep only one enabled`,
    );
  for (const { name, profile } of enabled) {
    if (profile.defaultAgentProfile !== undefined)
      namedProfile(config, profile.defaultAgentProfile, defaultAgentOrigin(name));
  }
  if (config.code.fallbackProfile !== undefined)
    namedProfile(config, config.code.fallbackProfile, "code.fallbackProfile");
}

// A disabled profile is absent for the CLI.
function enabledProfiles(config: LoadedConfig): NamedProfile[] {
  return Object.entries(config.code.profiles ?? {})
    .filter(([, profile]) => profile.disabled !== true)
    .map(([name, profile]) => ({ name, profile }));
}

export function enabledCodingProfiles(config: LoadedConfig): NamedProfile<CodingProfile>[] {
  return enabledProfiles(config).filter(isCodingProfile);
}

function isCodingProfile(entry: NamedProfile): entry is NamedProfile<CodingProfile> {
  return entry.profile.harness !== "openclaw";
}

function isOpenclawProfile(entry: NamedProfile): entry is NamedProfile<OpenclawProfile> {
  return entry.profile.harness === "openclaw";
}

function quotedNames(entries: NamedProfile[]): string {
  return entries.map(({ name }) => JSON.stringify(name)).join(", ");
}

function defaultAgentOrigin(name: string): string {
  return `code.profiles[${JSON.stringify(name)}].defaultAgentProfile`;
}

// `name` is undefined for the built-in defaults of a harness.
interface SelectedProfile {
  name?: string;
  profile: CodingProfile;
}

function selectProfile(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  assistant: AssistantHarness,
  selection: ProfileSelection,
): SelectedProfile {
  const { explicit, project, recorded } = selection;
  if (explicit !== undefined) return namedProfile(config, explicit, "--profile");
  if (project?.profile !== undefined)
    return namedProfile(config, project.profile, "the project registry selection");
  if (typeof recorded === "string") return namedProfile(config, recorded, "the recorded profile");
  if (recorded === null) return { profile: { harness: historicalHarness(assistant) } };
  return automaticProfile(config, env, assistant);
}

// A named reference never falls through to another profile.
function namedProfile(config: LoadedConfig, name: string, origin: string): SelectedProfile {
  const profile = Object.hasOwn(config.code.profiles ?? {}, name)
    ? config.code.profiles?.[name]
    : undefined;
  const quoted = JSON.stringify(name);
  if (name.trim() === "" || profile === undefined) {
    throw invalidConfig(
      config.path,
      `${origin} names missing profile ${quoted}; define it in code.profiles or select another profile`,
    );
  }
  if (profile.disabled === true) {
    throw invalidConfig(
      config.path,
      `${origin} names disabled profile ${quoted}; enable it or select another profile`,
    );
  }
  if (profile.harness === "openclaw") {
    throw invalidConfig(
      config.path,
      `${origin} names openclaw profile ${quoted}, which launches no coding agent; ` +
        "select a coding-agent profile",
    );
  }
  return { name, profile };
}

// A session recorded without a profile resumes on the built-ins of the assistant's harness.
function historicalHarness(assistant: AssistantHarness): CodingAgent {
  const { harness } = assistant;
  if (harness !== undefined && harness !== "openclaw") return harness;
  const reason =
    harness === "openclaw" ? "the assistant's harness is openclaw" : unrecognizedHarness(assistant);
  throw new Error(
    "Error: a session without a recorded profile resumes with the built-ins of the assistant's " +
      `harness, but ${reason}: select --profile or a project registry profile.`,
  );
}

function unrecognizedHarness({ detected }: AssistantHarness): string {
  return detected.length > 1
    ? `the assistant's harness is not recognized (several coding agents detected: ${detected.join(", ")})`
    : "the assistant's harness is not recognized (no coding agent detected)";
}

function automaticProfile(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  assistant: AssistantHarness,
): SelectedProfile {
  const { harness } = assistant;
  if (harness === undefined) return fallbackProfile(config, assistant);
  if (harness === "openclaw") {
    const own = enabledProfiles(config).find(isOpenclawProfile);
    if (own === undefined) return fallbackProfile(config, assistant);
    return namedProfile(config, own.profile.defaultAgentProfile, defaultAgentOrigin(own.name));
  }
  const own = codingAssistantProfile(config, env, harness);
  if (own === undefined) return { profile: { harness } };
  const target = own.profile.defaultAgentProfile;
  return target === undefined ? own : namedProfile(config, target, defaultAgentOrigin(own.name));
}

// The enabled profile of the assistant's harness whose configDir matches the session's native
// directory. An exact match (null for an unset variable, a path for the same directory) wins;
// profiles with an omitted configDir match any session and apply only without an exact match.
// A harness without a directory variable has only such profiles.
function codingAssistantProfile(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv,
  harness: CodingAgent,
): NamedProfile<CodingProfile> | undefined {
  const own = enabledCodingProfiles(config).filter(({ profile }) => profile.harness === harness);
  const variable = CONFIG_DIRECTORY_VARIABLES[harness];
  const value = variable === undefined ? undefined : env[variable];
  const directory = value === "" ? undefined : value;
  const exact = own.filter(({ profile }) => matchesDirectory(profile.configDir, directory));
  const candidates =
    exact.length > 0 ? exact : own.filter(({ profile }) => profile.configDir === undefined);
  if (candidates.length < 2) return candidates[0];
  const preferred = candidates.find(({ profile }) => profile.default === true);
  if (preferred !== undefined) return preferred;
  throw invalidConfig(
    config.path,
    `several profiles describe this ${harness} session: ${quotedNames(candidates)}; ` +
      "select --profile, a project registry profile, or set default: true on one of them",
  );
}

function matchesDirectory(
  configDir: string | null | undefined,
  directory: string | undefined,
): boolean {
  if (configDir === undefined) return false;
  if (configDir === null) return directory === undefined;
  return directory !== undefined && resolve(configDir) === resolve(directory);
}

function fallbackProfile(config: LoadedConfig, assistant: AssistantHarness): SelectedProfile {
  const fallback = config.code.fallbackProfile;
  if (fallback !== undefined) return namedProfile(config, fallback, "code.fallbackProfile");
  const reason =
    assistant.harness === "openclaw"
      ? "the assistant's harness is openclaw, without an enabled openclaw profile"
      : unrecognizedHarness(assistant);
  throw new Error(`Error: no coding-agent profile applies: ${reason}. ${fallbackRemedy(config)}`);
}

function fallbackRemedy(config: LoadedConfig): string {
  const names = enabledCodingProfiles(config).map(({ name }) => JSON.stringify(name));
  if (names.length === 1)
    return `Add "fallbackProfile": ${names[0]} under code in ${config.path}, or pass --profile.`;
  if (names.length > 1)
    return `Set code.fallbackProfile in ${config.path} to one of ${names.join(", ")}, or pass --profile.`;
  return (
    `Define a coding-agent profile under code.profiles in ${config.path}, then set ` +
    "code.fallbackProfile or pass --profile."
  );
}

function checkDefaultModel(code: CodingProfile, path: string, profile: string | undefined): void {
  if (code.defaultModel === undefined) return;
  const models = resolveModels(code.harness, code.models, code.modelAliases);
  if (models === undefined || models.includes(code.defaultModel)) return;
  throw invalidConfig(
    path,
    `code.profiles[${JSON.stringify(profile)}].defaultModel must be one of: ${models.join(", ")}`,
  );
}

function checkDefaultEffort(profile: CodingProfile, field: string, path: string): void {
  if (profile.defaultEffort === undefined) return;
  const efforts = resolveEfforts(profile.harness, profile.efforts);
  if (efforts.includes(profile.defaultEffort)) return;
  throw invalidConfig(path, `${field}.defaultEffort must be one of: ${efforts.join(", ")}`);
}

export function requireProjectsRoot(config: LoadedConfig): ProjectsRoot {
  if (config.projectsRoot !== undefined) return config.projectsRoot;
  throw new Error(`Error: projectsRoot is missing from the aligndev config ${config.path}.`);
}
