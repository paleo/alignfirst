export interface ReadDevLimitOptions {
  projectVar: string;
  defaultLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export function readDevLimit(opts: ReadDevLimitOptions): number {
  const env = opts.env ?? process.env;
  const defaultLimit = opts.defaultLimit ?? 5;
  const candidates = [env[opts.projectVar], env.PROJECT_DEV_LIMIT];
  for (const raw of candidates) {
    if (raw === undefined || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return defaultLimit;
}
