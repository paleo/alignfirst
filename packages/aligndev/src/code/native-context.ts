import { type CodeConfig, CONFIG_DIRECTORY_VARIABLES } from "../config.js";

export function describeNativeStorage(code: CodeConfig): string {
  const variable = CONFIG_DIRECTORY_VARIABLES[code.agent];
  const directory =
    code.configDir === null
      ? `${variable}: unset by configDir: null; native defaults apply`
      : code.configDir === undefined
        ? describeVariable(code, variable)
        : `${variable}: configDir ${JSON.stringify(code.configDir)}`;
  const home = ["HOME", "USERPROFILE"]
    .filter((name) => code.childEnv[name] !== undefined || code.unset?.includes(name))
    .map((name) => describeVariable(code, name));
  return [directory, ...home].join("; ");
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
