/** Context threaded into every callback-managed server lifecycle hook. */
export interface ServerContext {
  /**
   * Worktree directory for this lifecycle call. Equals `process.cwd()` at start time for local
   * starts/stops; equals the victim entry's worktree for cross-worktree stops (eviction,
   * `dev:down --all`). Callbacks MUST thread this into every child-process call
   * (`{ cwd: ctx.cwd }` on `execSync`, `spawn`, etc.) and resolve relative paths against it.
   */
  cwd: string;
}

/** One process spawned and tracked by the runner. */
export interface SpawnServer {
  kind: "spawn";
  /** Short label used in logs and the registry. Derives `<runtimeDir>/logs/<name>.log`. */
  name: string;
  /** Command and arguments passed to `child_process.spawn`. */
  exec: { command: string; args: string[] };
  /** Port the process will listen on. Use `helpers.readPortFromEnvFile` / `readPortFromJsonFile`. */
  port: number;
  /** Returns `true` once the log content indicates the server is ready. */
  detectSuccess: (logContent: string) => boolean;
  /**
   * Returns a non-empty marker string when the log content indicates a fatal error, or `false`.
   * When omitted, `helpers.detectCommonJsError` is used as a default. To disable detection,
   * pass `() => false`.
   */
  detectError?: (logContent: string) => string | false;
}

/**
 * A resource whose lifecycle the user owns (typically Docker / databases). The runner only
 * invokes `start` and `stop`; it never spawns, polls logs, or tracks PIDs for callback servers.
 */
export interface CallbackServer {
  kind: "callback";
  /** Short label used in logs. */
  name: string;
  /** Must resolve only once the resource is ready. Thread `ctx.cwd` into every child-process call. */
  start: (ctx: ServerContext) => Promise<void>;
  /** Tears down the resource. Thread `ctx.cwd` into every child-process call. */
  stop: (ctx: ServerContext) => Promise<void>;
}

export type ServerDescriptor = SpawnServer | CallbackServer;
