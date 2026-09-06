export const CMD_PLACEHOLDER = "{{CMD}}";

export function resolveCommandForm(env: NodeJS.ProcessEnv): string {
  const userAgent = env.npm_config_user_agent;
  return userAgent === undefined || userAgent === "" ? "alignfirst" : "npx -y alignfirst";
}

export function renderCommandForm(text: string, form: string): string {
  return text.replaceAll(CMD_PLACEHOLDER, form);
}
