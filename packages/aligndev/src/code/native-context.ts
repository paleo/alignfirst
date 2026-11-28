import type { CodeConfig } from "../config.js";
import { CONFIG_DIRECTORY_VARIABLES } from "./harness-environment.js";
import type { ModelDiscoveryContext } from "./models.js";

// The storage of an agent without a native directory variable: Antigravity's.
const FIXED_NATIVE_STORAGE = "native store: fixed ~/.gemini; account in the OS keyring";

// A launch and `aligndev code models` address the same remembered model list.
export function modelDiscoveryContext(code: CodeConfig, cwd: string): ModelDiscoveryContext {
  return { cwd, env: code.childEnv, profile: code.profile ?? undefined };
}

export function nativeContext(code: CodeConfig): string {
  return `${describeProfile(code)} (${describeNativeStorage(code)})`;
}

export function describeProfile(code: CodeConfig): string {
  return `${code.harness} profile ${JSON.stringify(code.profile ?? "(built-in)")}`;
}

export function describeNativeStorage(code: CodeConfig): string {
  const home = ["HOME", "USERPROFILE"]
    .filter((name) => code.childEnv[name] !== undefined || code.unset?.includes(name))
    .map((name) => describeVariable(code, name));
  return [describeDirectory(code), ...home].join("; ");
}

function describeDirectory(code: CodeConfig): string {
  const variable = CONFIG_DIRECTORY_VARIABLES[code.harness];
  if (variable === undefined) return FIXED_NATIVE_STORAGE;
  if (code.configDir === null)
    return `${variable}: unset by configDir: null; native defaults apply`;
  if (code.configDir === undefined) return describeVariable(code, variable);
  return `${variable}: configDir ${JSON.stringify(code.configDir)}`;
}

function describeVariable(code: CodeConfig, name: string): string {
  if (code.env !== undefined && Object.hasOwn(code.env, name)) {
    return `${name}: profile env override (value omitted)`;
  }
  if (code.unset?.includes(name)) return `${name}: unset by profile; native defaults apply`;
  return code.childEnv[name] === undefined
    ? `${name}: native default storage`
    : `${name}: inherited environment`;
}
