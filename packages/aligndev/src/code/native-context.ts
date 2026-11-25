import { type CodeConfig, CONFIG_DIRECTORY_VARIABLES } from "../config.js";

// The storage of an agent without a native directory variable: Antigravity's.
export const FIXED_NATIVE_STORAGE = "native store: fixed ~/.gemini; account in the OS keyring";

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
    : `${name}: inherited environment (value omitted)`;
}
