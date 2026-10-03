// How printed commands name the two CLIs: the global commands, or their `npx` form when aligndev runs
// through a package manager. The variable is inherited, so the processes aligndev spawns agree. The rule
// mirrors `resolveCommandForm` in the alignfirst package.
export interface CommandForms {
  viaNpx: boolean;
  aligndev: string;
  alignfirst: string;
}

export function resolveCommandForms(env: NodeJS.ProcessEnv): CommandForms {
  const userAgent = env.npm_config_user_agent;
  const viaNpx = userAgent !== undefined && userAgent !== "";
  return viaNpx
    ? { viaNpx, aligndev: "npx -y aligndev", alignfirst: "npx -y alignfirst" }
    : { viaNpx, aligndev: "aligndev", alignfirst: "alignfirst" };
}
