// How printed commands name the two CLIs: the global commands, or their `npx` form when aldev runs
// through a package manager. The variable is inherited, so the processes aldev spawns agree. The rule
// mirrors `resolveCommandForm` in the alignfirst package.
export interface CommandForms {
  viaNpx: boolean;
  aldev: string;
  alignfirst: string;
}

export function resolveCommandForms(env: NodeJS.ProcessEnv): CommandForms {
  const userAgent = env.npm_config_user_agent;
  const viaNpx = userAgent !== undefined && userAgent !== "";
  return viaNpx
    ? { viaNpx, aldev: "npx -y aldev", alignfirst: "npx -y alignfirst" }
    : { viaNpx, aldev: "aldev", alignfirst: "alignfirst" };
}
