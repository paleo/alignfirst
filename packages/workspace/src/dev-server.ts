import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type DevCommand, renderDevHelp } from "./cli.js";
import {
  type DevSetupContext,
  type DevSetupInput,
  type DevSetupOptions,
  type RunFilesInputsProvider,
  runDevSetup,
} from "./dev-setup.js";
import {
  type DevServerEntry,
  assertNoPendingCleanup,
  completeDevServerCleanup,
  hasLiveSpawnPids,
  liveDevServers,
  evictOldest,
  findOwnEntry,
  listDevServers,
  type PortsLookup,
  printActiveServers,
  pruneAndPersist,
  registerDevServer,
  readDevServers,
  stopAllRegistered,
} from "./dev-servers-registry.js";
import { ConfigError, StartupError, WorkspaceError } from "./errors.js";
import type { RunFileEntry } from "./file-entries.js";
import {
  awaitAllReady,
  followLogFile,
  handleStartupFailure,
  LOG_TAIL_LINES,
  type PollableServer,
  replayTail,
} from "./log-polling.js";
import { defaultCommands, devCmd, installedCliCommand } from "./invocation.js";
import type { WorkspaceOperation, WorkspaceOutput } from "./operation.js";
import {
  canonicalCwd,
  detectPortConflicts,
  type PortConflict,
  type PortHolder,
  sweepStalePorts,
  waitForPortsFree,
} from "./port-holder.js";
import { type DevPortsConfig, type ResolvedDevPorts, resolveDevPortsConfig } from "./ports.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import { resolveServers } from "./server-descriptor.js";
import type {
  CallbackServer,
  ResolvedSpawnServer,
  ResolvedServerDescriptor,
  ServerContext,
  ServerDescriptor,
  SpawnServer,
} from "./server-descriptor.js";
import {
  workspaceRecipe,
  assertWorkspaceRecipe,
  findWorkspaceByPath,
  readWorkspaces,
  registryDirFor,
  resolveCurrentWorkspace,
  type ResolvedWorkspace,
  storedPortsOf,
} from "./workspaces.js";
import { detectWorktree, getWorktreeBranch, type WorktreeContext } from "./worktree.js";

export type { CallbackServer, ServerContext, ServerDescriptor, SpawnServer };

/** Configuration accepted by {@link runDevServer}. */
export interface DevServerConfig {
  /** Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`). */
  runtimeDir: string;
  /** Maximum concurrent dev-servers across all worktrees. Omit for no limit. */
  maxConcurrentDevServers?: number;
  /** The project's port range and the ports declared in it. Omit for a portless dev-server. */
  ports?: DevPortsConfig;
  /**
   * Gitignored files that carry ports or are needed only to run. `dev setup` writes them. Before a
   * start, it creates the missing ones, and rewrites the others only when the ports or the
   * `runFilesInputs` changed since the last write.
   */
  runFiles?: RunFileEntry[];
  /**
   * The values the run files depend on besides the ports, such as the environment variables their
   * patches read. A start rewrites the run files when one changes. `undefined` values are ignored.
   */
  runFilesInputs?: RunFilesInputsProvider;
  signal?: AbortSignal;
  /**
   * Workspace infrastructure: database, seed. Runs once per workspace, at its first `dev setup`,
   * and again with `dev setup --force`. MUST be idempotent. Names every resource it creates after
   * the workspace, so `WorkspaceConfig.purgeInfrastructure` finds it by name.
   */
  setup?: (ctx: DevSetupContext) => Promise<void> | void;
  /** One entry per server to start. Started in array order; stopped in reverse order. */
  servers: ServerDescriptor[];
  /** Builds the post-start summary printed to stdout. Defaults to a generic layout. */
  formatSummary?: DevSummaryFormatter;
}

export type DevSummaryFormatter = (ctx: DevServerSummaryContext) => string | Promise<string>;

function logFileFor(cwd: string, runtimeDir: string, name: string): string {
  return resolve(cwd, runtimeDir, "logs", `${encodeURIComponent(name)}.log`);
}

/**
 * Context passed to {@link DevServerConfig.formatSummary}. `port` and `pid` are present only for
 * `kind: "spawn"` servers; callback servers expose neither.
 */
export interface DevServerSummaryContext {
  signal?: AbortSignal;
  workspace: ResolvedWorkspace;
  ports: Record<string, number>;
  servers: { server: ResolvedServerDescriptor; port?: number; pid?: number; logFile?: string }[];
}

export async function runDevServer(
  config: DevServerConfig,
  operation: WorkspaceOperation & { command: DevCommand },
): Promise<void> {
  if (operation.command.kind === "help") {
    operation.output.text(renderDevHelp(operation.commands ?? defaultCommands));
    return;
  }
  installedCliCommand(operation.invocation, []);
  const kernel = createKernel(config, operation);
  readDevServers(kernel.worktree.mainWorktree, kernel.registryDir);
  const registered = findWorkspaceByPath(
    readWorkspaces(kernel.worktree.mainWorktree, kernel.registryDir),
    kernel.worktree.currentWorktree,
  );
  if (registered && operation.command.kind !== "list" && operation.command.kind !== "status") {
    assertWorkspaceRecipe(registered.entry.worktree, registered.entry.recipe);
  }
  await dispatch(operation.command, kernel);
}

/** Per-invocation state shared by every dev-server command. */
interface DevKernel extends WorkspaceOperation {
  config: RuntimeDevConfig;
  /** The validated `ports` group. `undefined` for a portless dev-server. */
  ports?: ResolvedDevPorts;
  worktree: WorktreeContext;
  /** The registry directory, relative to a worktree root. */
  registryDir: string;
}

interface RuntimeDevConfig extends DevServerConfig {
  output: WorkspaceOutput;
}

function createKernel(config: DevServerConfig, operation: WorkspaceOperation): DevKernel {
  const ports = config.ports === undefined ? undefined : resolveDevPortsConfig(config.ports);
  checkSpawnPortNames(config.servers, ports);
  const worktree = detectWorktree(operation.cwd);
  return {
    ...operation,
    config: { ...config, output: operation.output },
    ports,
    worktree,
    registryDir: registryDirFor(config.runtimeDir),
  };
}

function checkSpawnPortNames(
  servers: ServerDescriptor[],
  ports: ResolvedDevPorts | undefined,
): void {
  for (const server of servers) {
    if (server.kind !== "spawn" || typeof server.port !== "string") continue;
    if (ports === undefined) {
      throw new ConfigError(
        `Config error: server "${server.name}" names the port "${server.port}", but the ` +
          "dev-server config declares no `ports`.",
      );
    }
    if (!ports.names.includes(server.port)) {
      throw new ConfigError(
        `Config error: server "${server.name}" names the port "${server.port}", absent from ` +
          "`ports.declare`.",
      );
    }
  }
}

async function dispatch(command: DevCommand, kernel: DevKernel): Promise<void> {
  const { worktree, registryDir } = kernel;
  switch (command.kind) {
    case "list":
      await listDevServers(worktree.mainWorktree, registryDir, kernel.output);
      return;
    case "down":
      if (command.all) {
        await stopAllRegistered({
          mainWorktree: worktree.mainWorktree,
          registryDir,
          callbackServers: callbackServersOf(kernel.config),
          portsOf: portsLookup(kernel),
          output: kernel.output,
        });
      } else {
        await stopLocal(kernel);
      }
      return;
    case "up":
      await start(kernel, { evict: command.evict, restart: command.restart });
      return;
    case "restart":
      await start(kernel, { evict: command.evict, restart: true });
      return;
    case "status":
      await printStatus(kernel);
      return;
    case "foreground":
      await runForeground(kernel, { evict: command.evict, restart: command.restart });
      return;
    case "setup":
      await runDevSetup(devSetupInput(kernel, { ...command, beforeStart: false }));
      kernel.output.text("Dev setup done.");
      return;
  }
}

function devSetupInput(kernel: DevKernel, options: DevSetupOptions): DevSetupInput {
  return {
    worktree: kernel.worktree,
    recipe: workspaceRecipe(kernel.worktree.currentWorktree),
    output: kernel.output,
    commands: kernel.commands,
    registryDir: kernel.registryDir,
    runtimeDir: kernel.config.runtimeDir,
    ports: kernel.ports,
    runFiles: kernel.config.runFiles ?? [],
    runFilesInputs: kernel.config.runFilesInputs,
    setup: kernel.config.setup,
    signal: kernel.config.signal,
    options: {
      force: options.force,
      resetPorts: options.resetPorts,
      fromFinalize: options.fromFinalize,
      beforeStart: options.beforeStart,
      verbose: options.verbose,
    },
  };
}

/** The ports of a worktree, read from its registry entry. */
function portsLookup(kernel: DevKernel): PortsLookup {
  return (worktree) => storedPortsOf(kernel.worktree.mainWorktree, kernel.registryDir, worktree);
}

async function printStatus(kernel: DevKernel): Promise<void> {
  const { worktree, registryDir } = kernel;
  const cwd = worktree.currentWorktree;
  const entry = findOwnEntry(worktree.mainWorktree, registryDir, cwd);
  if (!entry || !Object.values(entry.pids).some(isProcessAlive)) {
    kernel.output.text(
      entry?.cleanupPending === true
        ? "Dev-server status: cleanup pending."
        : "Dev-server status: DOWN.",
    );
    return;
  }
  kernel.output.text("Dev-server status: UP.");
  await printStartSummary(
    kernel.config,
    resolveCurrentWorkspace(worktree.mainWorktree, registryDir, worktree.currentWorktree),
    resolveServers(kernel.config.servers, {
      name: entry.name,
      cwd,
      ports: portsLookup(kernel)(cwd),
    }),
    entry.pids,
    portsLookup(kernel)(cwd),
  );
}

function callbackServersOf(config: DevServerConfig): CallbackServer[] {
  return config.servers.filter((s): s is CallbackServer => s.kind === "callback");
}

interface StartState {
  spawnPids: Record<string, number>;
  startedCallbacks: CallbackServer[];
}

interface StartOptions {
  evict: boolean;
  restart: boolean;
}

async function start(kernel: DevKernel, options: StartOptions): Promise<void> {
  const { config, worktree, registryDir } = kernel;
  const prepared = await runStartChecks(kernel, options);
  if (!prepared) return;
  const { workspace, ctx, servers } = prepared;

  const state: StartState = { spawnPids: Object.create(null), startedCallbacks: [] };
  await spawnWithRollback(config, ctx, state, servers);

  await registerStartedServer(worktree.mainWorktree, registryDir, workspace, state.spawnPids);
  await printStartSummary(config, workspace, servers, state.spawnPids, ctx.ports);
}

/**
 * Foreground start: hold the terminal and tail logs until CTRL+C, then stop cleanly. Signal
 * handlers are installed before starting so an interrupt during startup rolls back; after a
 * successful start they switch to the local stop sequence.
 */
async function runForeground(kernel: DevKernel, options: StartOptions): Promise<void> {
  const { config, worktree, registryDir } = kernel;
  const { mainWorktree } = worktree;
  const controller = new AbortController();
  config.signal =
    config.signal === undefined
      ? controller.signal
      : AbortSignal.any([config.signal, controller.signal]);
  if (!options.restart) {
    const running = findOwnLiveEntry(mainWorktree, registryDir, worktree.currentWorktree);
    if (running) return attachForeground(config, running);
  }

  const state: StartState = { spawnPids: Object.create(null), startedCallbacks: [] };
  let started = false;
  let shuttingDown = false;

  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (started) {
      void shutdownForeground(kernel);
    } else {
      controller.abort();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let prepared: PreparedStart | undefined;
  try {
    prepared = await runStartChecks(kernel, options);
    if (!prepared) process.exit(0);
    const { workspace, ctx, servers } = prepared;
    const streamLogs = (): void =>
      tailLogs(config, workspace.worktree, state.spawnPids, { fromStart: true });
    await spawnWithRollback(config, ctx, state, servers, streamLogs);
    ctx.signal?.throwIfAborted();
  } catch (error) {
    if (shuttingDown) process.exit(130);
    throw error;
  }
  const { workspace, ctx, servers } = prepared;
  await registerStartedServer(mainWorktree, registryDir, workspace, state.spawnPids);
  started = true;
  await printStartSummary(config, workspace, servers, state.spawnPids, ctx.ports);
  watchForExternalStop(Object.values(state.spawnPids), () => {
    if (shuttingDown) return;
    shuttingDown = true;
    kernel.output.text(`\nDev-server stopped externally (e.g. \`${devCmd("down")}\`). Exiting.`);
    process.exit(0);
  });
  await new Promise<never>(() => {});
}

function findOwnLiveEntry(
  mainWorktree: string,
  registryDir: string,
  cwd: string,
): DevServerEntry | undefined {
  const entry = findOwnEntry(mainWorktree, registryDir, cwd);
  assertNoPendingCleanup(mainWorktree, registryDir, cwd);
  if (!entry) return;
  return hasLiveSpawnPids(entry) ? entry : undefined;
}

/**
 * Attach to a dev-server already running in this worktree: replay the recent log, follow it live,
 * and exit when it stops. CTRL+C only detaches — this session does not own the server.
 */
async function attachForeground(config: RuntimeDevConfig, entry: DevServerEntry): Promise<void> {
  const pidList = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(", ");
  config.output.text(
    `Attaching to the dev-server in this worktree (workspace ${entry.name}, pids: ${pidList}).`,
  );
  config.output.text("Showing live logs. Press CTRL+C to detach — the dev-server keeps running.");

  let detaching = false;
  const onSignal = (): void => {
    if (detaching) return;
    detaching = true;
    config.output.text(
      `\nDetached. The dev-server is still running (\`${devCmd("down")}\` to stop it).`,
    );
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  tailLogs(config, entry.worktree, entry.pids, { replayLines: LOG_TAIL_LINES });
  watchForExternalStop(Object.values(entry.pids).filter(isProcessAlive), () => {
    if (detaching) return;
    detaching = true;
    config.output.text(`\nDev-server stopped externally (e.g. \`${devCmd("down")}\`). Exiting.`);
    process.exit(0);
  });
  await new Promise<never>(() => {});
}

async function shutdownForeground(kernel: DevKernel): Promise<void> {
  kernel.output.text("\nStopping dev servers...");
  await stopLocal(kernel);
  kernel.output.text("Stopped.");
  process.exit(0);
}

interface PreparedStart {
  workspace: ResolvedWorkspace;
  ctx: ServerContext;
  servers: ResolvedServerDescriptor[];
}

/** Prepares the authoritative identity and ports before any server callback can run. */
async function runStartChecks(
  kernel: DevKernel,
  { evict, restart }: StartOptions,
): Promise<PreparedStart | undefined> {
  const { mainWorktree, currentWorktree } = kernel.worktree;
  assertNoPendingCleanup(mainWorktree, kernel.registryDir, currentWorktree);
  if (await handleAlreadyRunning(kernel, currentWorktree, restart)) return;
  const { workspace, ports } = await runDevSetup(
    devSetupInput(kernel, {
      force: false,
      resetPorts: false,
      fromFinalize: false,
      beforeStart: true,
    }),
  );
  const ctx: ServerContext = {
    name: workspace.name,
    cwd: workspace.worktree,
    ports,
    signal: kernel.config.signal,
  };
  ctx.signal?.throwIfAborted();
  await enforceCap(kernel, evict);
  await checkNoLocalRegistryConflict(mainWorktree, kernel.registryDir, ctx.cwd);
  const servers = resolveServers(kernel.config.servers, ctx);
  const pins = workspace.main === true ? (kernel.ports?.mainWorktree ?? {}) : {};
  await checkPortsFree(servers, ctx.cwd, pins, kernel.output);
  return { workspace, ctx, servers };
}

/**
 * Spawn the resolved descriptors and await readiness, rolling back on failure or cancellation.
 */
async function spawnWithRollback(
  config: RuntimeDevConfig,
  ctx: ServerContext,
  state: StartState,
  servers: ResolvedServerDescriptor[],
  onSpawned?: () => void,
): Promise<void> {
  try {
    await spawnAndAwait(config, ctx, state, servers, onSpawned);
    ctx.signal?.throwIfAborted();
  } catch (err) {
    await rollbackStart(state.spawnPids, state.startedCallbacks, ctx, config.output);
    ctx.signal?.throwIfAborted();
    if (err instanceof StartupError) {
      // The foreground (onSpawned set) already streamed the log live, so skip the redundant tail.
      handleStartupFailure(err, { includeTail: onSpawned === undefined, output: config.output });
      throw new WorkspaceError(`${err.label}: ${err.reason}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Wraps an error thrown by a callback server's `start()` into a {@link StartupError}, so a failing
 * callback (e.g. `docker compose up -d`) gets the same clean rollback-and-report path as a spawn
 * server instead of surfacing as a raw unhandled-rejection stack trace.
 */
export function toCallbackStartupError(name: string, err: unknown): StartupError {
  if (err instanceof StartupError) return err;
  return new StartupError(name, err instanceof Error ? err.message : String(err));
}

async function spawnAndAwait(
  config: RuntimeDevConfig,
  ctx: ServerContext,
  state: StartState,
  servers: ResolvedServerDescriptor[],
  onSpawned?: () => void,
): Promise<void> {
  for (const server of servers) {
    ctx.signal?.throwIfAborted();
    config.output.text(`Starting ${server.name} dev server...`);
    if (server.kind === "spawn") {
      state.spawnPids[server.name] = await spawnServer(server, config.runtimeDir, ctx.cwd);
    } else {
      try {
        await server.start(ctx);
      } catch (err) {
        ctx.signal?.throwIfAborted();
        throw toCallbackStartupError(server.name, err);
      }
      state.startedCallbacks.push(server);
    }
  }
  onSpawned?.();

  ctx.signal?.throwIfAborted();
  const spawnEntries = servers.filter((s): s is ResolvedSpawnServer => s.kind === "spawn");
  const pollables: PollableServer[] = spawnEntries.map((s) => ({
    name: s.name,
    logFile: logFileFor(ctx.cwd, config.runtimeDir, s.name),
    detectReady: s.detectReady,
    detectError: s.detectError,
  }));
  const pollPids = spawnEntries.map((s) => state.spawnPids[s.name]);
  await awaitAllReady(pollables, pollPids, { signal: ctx.signal });
}

async function registerStartedServer(
  mainWorktree: string,
  registryDir: string,
  workspace: ResolvedWorkspace,
  spawnPids: Record<string, number>,
): Promise<void> {
  const devEntry: DevServerEntry = {
    name: workspace.name,
    worktree: workspace.worktree,
    pids: spawnPids,
    startedAt: new Date().toISOString(),
  };
  if (workspace.main) devEntry.main = true;
  await registerDevServer(mainWorktree, registryDir, devEntry);
}

async function printStartSummary(
  config: RuntimeDevConfig,
  workspace: ResolvedWorkspace,
  servers: ResolvedServerDescriptor[],
  spawnPids: Record<string, number>,
  ports: Record<string, number>,
): Promise<void> {
  const summaryServers = servers.map((server) => {
    if (server.kind === "spawn") {
      return {
        server,
        port: server.port,
        pid: spawnPids[server.name],
        logFile: logFileFor(workspace.worktree, config.runtimeDir, server.name),
      };
    }
    return { server };
  });
  if (config.formatSummary) {
    config.output.text(
      await config.formatSummary({
        workspace,
        servers: summaryServers,
        ports,
        signal: config.signal,
      }),
    );
  } else {
    defaultPrintSummary(workspace, summaryServers, config.runtimeDir, config.output);
  }
}

const LIVENESS_POLL_MS = 1000;

// `fromStart` follows from the first byte (fresh start); `replayLines` prints the last N lines of
// an existing log before following (attaching to a running server).
type TailMode = { fromStart: true } | { replayLines: number };

function tailLogs(
  config: RuntimeDevConfig,
  cwd: string,
  spawnPids: Record<string, number>,
  mode: TailMode,
): void {
  const names = Object.keys(spawnPids);
  const prefixed = names.length > 1;
  for (const name of names) {
    const path = logFileFor(cwd, config.runtimeDir, name);
    const prefix = prefixed ? `[${name}] ` : "";
    const offset =
      "fromStart" in mode ? 0 : replayTail(path, prefix, mode.replayLines, config.output.write);
    followLogFile(path, prefix, offset, config.output.write);
  }
}

/**
 * Poll the foreground's own spawn PIDs; when none remain alive, the servers were stopped from
 * outside this process (`dev down`, `down --all`, eviction, or a manual kill). Fires `onStopped`
 * once so the foreground can exit instead of hanging on dead servers.
 */
export function watchForExternalStop(
  pids: number[],
  onStopped: () => void,
  isAlive: (pid: number) => boolean = isProcessAlive,
  intervalMs: number = LIVENESS_POLL_MS,
): NodeJS.Timeout | undefined {
  if (pids.length === 0) return;
  const timer = setInterval(() => {
    if (pids.some(isAlive)) return;
    clearInterval(timer);
    onStopped();
  }, intervalMs);
  return timer;
}

async function rollbackStart(
  spawnPids: Record<string, number>,
  startedCallbacks: CallbackServer[],
  ctx: ServerContext,
  output: WorkspaceOutput,
): Promise<void> {
  output.diagnostic("\nStopping dev servers...");
  for (const pid of Object.values(spawnPids)) {
    try {
      await stopProcessGroup(pid);
    } catch (err) {
      output.diagnostic(`  Failed to stop PID ${pid}: ${(err as Error).message}`);
    }
  }
  for (const server of [...startedCallbacks].reverse()) {
    output.text(`Stopping ${server.name}...`);
    try {
      await server.stop({ ...ctx, signal: new AbortController().signal });
    } catch (err) {
      output.diagnostic(`  Failed to stop ${server.name}: ${(err as Error).message}`);
    }
  }
}

/**
 * If a dev-server is already running in this worktree, either stop it (when `restart`) so the
 * normal start path can proceed, or print a friendly notice and return `true` to short-circuit.
 * Returns `true` when the caller should exit cleanly without starting.
 */
async function handleAlreadyRunning(
  kernel: DevKernel,
  cwd: string,
  restart: boolean,
): Promise<boolean> {
  const entry = findOwnEntry(kernel.worktree.mainWorktree, kernel.registryDir, cwd);
  if (!entry) return false;
  const livePids = Object.entries(entry.pids).filter(([, pid]) => isProcessAlive(pid));
  assertNoPendingCleanup(kernel.worktree.mainWorktree, kernel.registryDir, cwd);
  if (livePids.length === 0) return false;

  if (restart) {
    kernel.output.text("Restarting dev-server in this worktree...");
    await stopLocal(kernel);
    return false;
  }

  const pidList = livePids.map(([name, pid]) => `${name}=${pid}`).join(", ");
  kernel.output.text(
    `dev-server already running for this worktree (workspace ${entry.name}, pids: ${pidList}).`,
  );
  kernel.output.text(
    `Run \`${devCmd("down")}\` to stop it, or re-run with \`--restart\` to restart.`,
  );
  return true;
}

// TOCTOU: the cap check and the subsequent register are not atomic. Two concurrent `dev up --evict`
// from different worktrees can both pass the cap check and both register, exceeding the limit by
// one. Accepted: the race window is narrow and the consequence is bounded (one extra dev-server).
async function enforceCap(kernel: DevKernel, evict: boolean): Promise<void> {
  const { config, registryDir } = kernel;
  const { mainWorktree } = kernel.worktree;
  const limit = config.maxConcurrentDevServers;
  if (limit === undefined) return;
  const active = liveDevServers(await pruneAndPersist(mainWorktree, registryDir));
  if (active.length < limit) return;

  if (!evict) {
    printActiveServers(active, kernel.output);
    throw new WorkspaceError(
      `dev-server cap reached (${active.length}/${limit}). Run \`${devCmd("down")}\` in another worktree, or re-run with --evict.`,
    );
  }

  const toEvict = active.length - limit + 1;
  kernel.output.text(`Evicting ${toEvict} dev-server(s) to make room (cap ${limit}).`);
  const evicted = await evictOldest({
    mainWorktree,
    registryDir,
    callbackServers: callbackServersOf(config),
    portsOf: portsLookup(kernel),
    count: toEvict,
    output: kernel.output,
  });
  for (const entry of evicted) {
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    kernel.output.text(
      `Evicted workspace ${entry.name} (branch=${branch}, startedAt=${entry.startedAt}).`,
    );
  }
}

/** `pins`: the main worktree's pinned ports, by name; empty in a linked workspace. */
async function checkPortsFree(
  servers: ResolvedServerDescriptor[],
  cwd: string,
  pins: Record<string, number>,
  output: WorkspaceOutput,
): Promise<void> {
  const conflicts = await detectPortConflicts(servers, canonicalCwd(cwd));
  const foreign = conflicts.filter(
    (c): c is Extract<PortConflict, { kind: "foreign" }> => c.kind === "foreign",
  );
  if (foreign.length > 0) {
    throw new WorkspaceError(foreign.map((c) => foreignHolderMessage(c, pins)).join("\n"));
  }
  const ours = conflicts.filter(
    (c): c is Extract<PortConflict, { kind: "ours" }> => c.kind === "ours",
  );
  if (ours.length === 0) return;
  for (const c of ours) {
    output.diagnostic(
      `Stale ${c.server.name} dev-server detected on port ${c.server.port} (PID ${c.holder.pid}: ${c.holder.cmd}). Cleaning up...`,
    );
    if (c.holder.pgid === undefined) {
      throw new WorkspaceError(`Cannot kill: pgid unknown for PID ${c.holder.pid}.`);
    }
    await stopProcessGroup(c.holder.pgid);
  }
  const stillBusy = await waitForPortsFree(
    ours.map((c) => c.server.port),
    2000,
  );
  if (stillBusy.length > 0) {
    throw new WorkspaceError(`Ports ${stillBusy.join(", ")} still in use after cleanup attempt.`);
  }
}

function foreignHolderMessage(
  conflict: Extract<PortConflict, { kind: "foreign" }>,
  pins: Record<string, number>,
): string {
  const { server, holder } = conflict;
  const label = `Port ${server.port} (${server.name})`;
  if (server.portName !== undefined && pins[server.portName] === server.port) {
    return (
      `Error: ${label} is pinned by the \`mainWorktree\` of "${server.portName}" in ` +
      `\`ports.declare\` and held by ${describeHolder(holder)}. Free it, or change that pin.`
    );
  }
  const info = holder ? ` (${describeHolder(holder)})` : "";
  const hint =
    server.portName === undefined
      ? ""
      : ` Free it, or move this workspace's ports with \`${devCmd("setup --reset-ports")}\`.`;
  return `Error: ${label} is already in use${info}.${hint}`;
}

function describeHolder(holder: PortHolder | undefined): string {
  if (!holder) return "another process";
  return `PID ${holder.pid}: ${holder.cmd}${holder.cwd ? `, cwd ${holder.cwd}` : ""}`;
}

async function checkNoLocalRegistryConflict(
  mainWorktree: string,
  registryDir: string,
  cwd: string,
): Promise<void> {
  assertNoPendingCleanup(mainWorktree, registryDir, cwd);
  const entry = findOwnEntry(mainWorktree, registryDir, cwd);
  if (!entry) return;
  for (const [name, pid] of Object.entries(entry.pids)) {
    if (isProcessAlive(pid)) {
      throw new WorkspaceError(`${name} is already running (PID ${pid}).`);
    }
  }
  // Stale entry — drop it so registration overwrites cleanly.
  await completeDevServerCleanup(mainWorktree, registryDir, cwd, entry.startedAt);
}

async function stopLocal(kernel: DevKernel): Promise<void> {
  const { config, registryDir } = kernel;
  const { mainWorktree, currentWorktree } = kernel.worktree;
  const entry = findOwnEntry(mainWorktree, registryDir, currentWorktree);
  const cwd = entry?.worktree ?? currentWorktree;
  const ports = portsLookup(kernel)(cwd);
  const servers = resolveServers(config.servers, {
    name: entry?.name ?? "(unregistered)",
    cwd,
    ports,
  });
  if (!entry) {
    kernel.output.text("No dev-server running in this worktree.");
    await sweepStalePorts(servers, cwd);
    return;
  }
  const ctx: ServerContext = { name: entry.name, cwd, ports, signal: config.signal };
  for (const [name, pid] of Object.entries(entry.pids)) {
    if (!isProcessAlive(pid)) continue;
    kernel.output.text(`Stopping ${name} (PID ${pid})...`);
    await stopProcessGroup(pid);
  }
  const callbacks = callbackServersOf(config);
  for (const server of [...callbacks].reverse()) {
    kernel.output.text(`Stopping ${server.name}...`);
    await server.stop(ctx);
  }
  await completeDevServerCleanup(mainWorktree, registryDir, ctx.cwd, entry.startedAt);
  await sweepStalePorts(servers, ctx.cwd);
}

function defaultPrintSummary(
  workspace: ResolvedWorkspace,
  servers: DevServerSummaryContext["servers"],
  runtimeDir: string,
  output: WorkspaceOutput,
): void {
  output.text("\nDev servers started!");
  output.text(`  Workspace: ${workspace.name}`);
  for (const { server, port, pid } of servers) {
    if (server.kind !== "spawn") {
      output.text(`  ${server.name}: ready`);
      continue;
    }
    const target = port === undefined ? `PID ${pid}` : `http://localhost:${port}/  (PID ${pid})`;
    output.text(`  ${server.name}: ${target}`);
    output.text(`    log: ${logFileFor(workspace.worktree, runtimeDir, server.name)}`);
  }
  output.text("");
}

async function spawnServer(
  server: ResolvedSpawnServer,
  runtimeDir: string,
  cwd: string,
): Promise<number> {
  const logFile = logFileFor(cwd, runtimeDir, server.name);
  mkdirSync(dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, "w");
  const child = spawn(server.exec.command, server.exec.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: server.exec.cwd,
    env: server.exec.env,
  });
  closeSync(logFd);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new StartupError(server.name, "process launch failed", logFile)),
    );
  });
  if (child.pid === undefined)
    throw new StartupError(server.name, "process launch failed", logFile);
  child.unref();
  return child.pid;
}
