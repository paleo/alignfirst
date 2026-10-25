import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type DevCommand, parseDevArgs, printDevHelp } from "./cli.js";
import {
  type DevSetupContext,
  type DevSetupInput,
  type DevSetupOptions,
  runDevSetup,
} from "./dev-setup.js";
import {
  type DevServerEntry,
  evictOldest,
  findOwnEntry,
  listDevServers,
  type PortsLookup,
  printActiveServers,
  pruneAndPersist,
  registerDevServer,
  removeDevServerEntryByWorktree,
  stopAllRegistered,
  unregisterDevServer,
} from "./dev-servers-registry.js";
import { ConfigError, StartupError, WorkspaceError } from "./errors.js";
import type { RunFileEntry } from "./file-entries.js";
import { detectCommonJsError } from "./helpers.js";
import { refuseOldRegistry } from "./migrate.js";
import {
  awaitAllReady,
  followLogFile,
  handleStartupFailure,
  LOG_TAIL_LINES,
  type PollableServer,
  replayTail,
} from "./log-polling.js";
import { configureCommands, devCmd } from "./package-manager.js";
import { checkPortClaim } from "./port-claim.js";
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
import type {
  CallbackServer,
  ResolvedServerDescriptor,
  ServerContext,
  ServerDescriptor,
  SpawnServer,
} from "./server-descriptor.js";
import {
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
  runFilesInputs?: () => Record<string, string | undefined>;
  /**
   * Workspace infrastructure: database, seed. Runs once per workspace, at its first `dev setup`,
   * and again with `dev setup --force`. MUST be idempotent. Names every resource it creates after
   * the workspace, so `WorkspaceConfig.purgeInfrastructure` finds it by name.
   */
  setup?: (ctx: DevSetupContext) => Promise<void> | void;
  /** One entry per server to start. Started in array order; stopped in reverse order. */
  servers: ServerDescriptor[];
  /** Builds the post-start summary printed to stdout. Defaults to a generic layout. */
  formatSummary?: (ctx: DevServerSummaryContext) => string;
}

function logFileFor(cwd: string, runtimeDir: string, name: string): string {
  return resolve(cwd, runtimeDir, "logs", `${name}.log`);
}

/**
 * Context passed to {@link DevServerConfig.formatSummary}. `port` and `pid` are present only for
 * `kind: "spawn"` servers; callback servers expose neither.
 */
export interface DevServerSummaryContext {
  workspace: ResolvedWorkspace;
  servers: { server: ServerDescriptor; port?: number; pid?: number }[];
}

export async function runDevServer(config: DevServerConfig): Promise<void> {
  configureCommands({ dev: process.argv[1] });
  let command: DevCommand;
  try {
    command = parseDevArgs();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Warning: ${err.message}`);
      printDevHelp();
      process.exit(1);
    }
    throw err;
  }

  if (command.kind === "help") {
    printDevHelp();
    return;
  }

  try {
    const kernel = createKernel(config);
    refuseOldRegistry(kernel.worktree.mainWorktree, kernel.registryDir);
    await dispatch(command, kernel);
  } catch (err) {
    if (err instanceof WorkspaceError || err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** Per-invocation state shared by every dev-server command. */
interface DevKernel {
  config: DevServerConfig;
  /** The validated `ports` group. `undefined` for a portless dev-server. */
  ports?: ResolvedDevPorts;
  worktree: WorktreeContext;
  /** The registry directory, relative to a worktree root. */
  registryDir: string;
}

function createKernel(config: DevServerConfig): DevKernel {
  const ports = config.ports === undefined ? undefined : resolveDevPortsConfig(config.ports);
  checkSpawnPortNames(config.servers, ports);
  const worktree = detectWorktree();
  checkPortClaim(worktree.currentWorktree, ports);
  return { config, ports, worktree, registryDir: registryDirFor(config.runtimeDir) };
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
      listDevServers(worktree.mainWorktree, registryDir);
      return;
    case "down":
      if (command.all) {
        await stopAllRegistered({
          mainWorktree: worktree.mainWorktree,
          registryDir,
          callbackServers: callbackServersOf(kernel.config),
          portsOf: portsLookup(kernel),
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
      printStatus(kernel);
      return;
    case "foreground":
      await runForeground(kernel, { evict: command.evict, restart: command.restart });
      return;
    case "setup":
      await runDevSetup(devSetupInput(kernel, { ...command, beforeStart: false }));
      console.log("Dev setup done.");
      return;
  }
}

function devSetupInput(kernel: DevKernel, options: DevSetupOptions): DevSetupInput {
  return {
    worktree: kernel.worktree,
    registryDir: kernel.registryDir,
    runtimeDir: kernel.config.runtimeDir,
    ports: kernel.ports,
    runFiles: kernel.config.runFiles ?? [],
    runFilesInputs: kernel.config.runFilesInputs,
    setup: kernel.config.setup,
    options: {
      force: options.force,
      resetPorts: options.resetPorts,
      fromFinalize: options.fromFinalize,
      beforeStart: options.beforeStart,
    },
  };
}

/** The ports of a worktree, read from its registry entry. */
function portsLookup(kernel: DevKernel): PortsLookup {
  return (worktree) => storedPortsOf(kernel.worktree.mainWorktree, kernel.registryDir, worktree);
}

function printStatus(kernel: DevKernel): void {
  const { worktree, registryDir } = kernel;
  const cwd = worktree.currentWorktree;
  const entry = findOwnEntry(worktree.mainWorktree, registryDir, cwd);
  if (!entry || !Object.values(entry.pids).some(isProcessAlive)) {
    console.log("Dev-server status: DOWN.");
    return;
  }
  console.log("Dev-server status: UP.");
  printStartSummary(
    kernel.config,
    resolveCurrentWorkspace(worktree.mainWorktree, registryDir, worktree.currentWorktree),
    resolveSpawnPorts(kernel.config.servers, portsLookup(kernel)(cwd)),
    entry.pids,
  );
}

/**
 * Maps each spawn server's `port` to a number: a port name resolves through the workspace's
 * ports. A name the workspace has no port for yet leaves the server without a port.
 */
function resolveSpawnPorts(
  servers: ServerDescriptor[],
  ports: Record<string, number>,
): ResolvedServerDescriptor[] {
  return servers.map((server): ResolvedServerDescriptor => {
    if (server.kind !== "spawn") return server;
    const { port, ...rest } = server;
    if (typeof port !== "string") return { ...rest, port };
    return { ...rest, port: ports[port], portName: port };
  });
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

  const state: StartState = { spawnPids: {}, startedCallbacks: [] };
  await spawnWithRollback(config, ctx, state);

  registerStartedServer(worktree.mainWorktree, registryDir, workspace, state.spawnPids);
  printStartSummary(config, workspace, servers, state.spawnPids);
}

/**
 * Foreground start: hold the terminal and tail logs until CTRL+C, then stop cleanly. Signal
 * handlers are installed before starting so an interrupt during startup rolls back; after a
 * successful start they switch to the local stop sequence.
 */
async function runForeground(kernel: DevKernel, options: StartOptions): Promise<void> {
  const { config, worktree, registryDir } = kernel;
  const { mainWorktree } = worktree;
  let ctx: ServerContext | undefined;
  if (!options.restart) {
    const running = findOwnLiveEntry(mainWorktree, registryDir, worktree.currentWorktree);
    if (running) return attachForeground(config, running);
  }

  const state: StartState = { spawnPids: {}, startedCallbacks: [] };
  let started = false;
  let shuttingDown = false;

  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (started) {
      void shutdownForeground(kernel);
    } else if (ctx) {
      void rollbackStart(state.spawnPids, state.startedCallbacks, ctx).then(() =>
        process.exit(130),
      );
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const prepared = await runStartChecks(kernel, options);
  if (shuttingDown) await new Promise<never>(() => {});
  if (!prepared) process.exit(0);
  const { workspace, servers } = prepared;
  ctx = prepared.ctx;

  // Stream logs from the first byte so the whole startup (e.g. a slow build) is visible live.
  const streamLogs = (): void =>
    tailLogs(config, workspace.worktree, state.spawnPids, { fromStart: true });
  // A signal during startup hands teardown to onSignal (rollback + exit 130); block so we
  // neither roll back twice nor register a server that is being torn down.
  if (!(await spawnWithRollback(config, ctx, state, () => shuttingDown, streamLogs))) {
    await new Promise<never>(() => {});
  }

  registerStartedServer(mainWorktree, registryDir, workspace, state.spawnPids);
  started = true;
  printStartSummary(config, workspace, servers, state.spawnPids);
  watchForExternalStop(Object.values(state.spawnPids), () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nDev-server stopped externally (e.g. \`${devCmd("down")}\`). Exiting.`);
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
  if (!entry) return;
  return Object.values(entry.pids).some(isProcessAlive) ? entry : undefined;
}

/**
 * Attach to a dev-server already running in this worktree: replay the recent log, follow it live,
 * and exit when it stops. CTRL+C only detaches — this session does not own the server.
 */
async function attachForeground(config: DevServerConfig, entry: DevServerEntry): Promise<void> {
  const pidList = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(", ");
  console.log(
    `Attaching to the dev-server in this worktree (workspace ${entry.name}, pids: ${pidList}).`,
  );
  console.log("Showing live logs. Press CTRL+C to detach — the dev-server keeps running.");

  let detaching = false;
  const onSignal = (): void => {
    if (detaching) return;
    detaching = true;
    console.log(`\nDetached. The dev-server is still running (\`${devCmd("down")}\` to stop it).`);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  tailLogs(config, entry.worktree, entry.pids, { replayLines: LOG_TAIL_LINES });
  watchForExternalStop(Object.values(entry.pids).filter(isProcessAlive), () => {
    if (detaching) return;
    detaching = true;
    console.log(`\nDev-server stopped externally (e.g. \`${devCmd("down")}\`). Exiting.`);
    process.exit(0);
  });
  await new Promise<never>(() => {});
}

async function shutdownForeground(kernel: DevKernel): Promise<void> {
  console.log("\nStopping dev servers...");
  await stopLocal(kernel);
  console.log("Stopped.");
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
  if (await handleAlreadyRunning(kernel, currentWorktree, restart)) return;
  const { workspace, ports } = await runDevSetup(
    devSetupInput(kernel, {
      force: false,
      resetPorts: false,
      fromFinalize: false,
      beforeStart: true,
    }),
  );
  const ctx: ServerContext = { name: workspace.name, cwd: workspace.worktree, ports };
  await enforceCap(kernel, evict);
  checkNoLocalRegistryConflict(mainWorktree, kernel.registryDir, ctx.cwd);
  const servers = resolveSpawnPorts(kernel.config.servers, ports);
  const pins = workspace.main === true ? (kernel.ports?.mainWorktree ?? {}) : {};
  await checkPortsFree(servers, ctx.cwd, pins);
  return { workspace, ctx, servers };
}

/**
 * Spawn and await readiness, rolling back on failure. Returns `false` when `isAborted` reports a
 * concurrent shutdown — the caller must then yield teardown to whoever set it, not proceed.
 */
async function spawnWithRollback(
  config: DevServerConfig,
  ctx: ServerContext,
  state: StartState,
  isAborted: () => boolean = () => false,
  onSpawned?: () => void,
): Promise<boolean> {
  try {
    await spawnAndAwait(config, ctx, state, onSpawned);
  } catch (err) {
    if (isAborted()) return false;
    await rollbackStart(state.spawnPids, state.startedCallbacks, ctx);
    if (err instanceof StartupError) {
      // The foreground (onSpawned set) already streamed the log live, so skip the redundant tail.
      handleStartupFailure(err, { includeTail: onSpawned === undefined });
      process.exit(1);
    }
    throw err;
  }
  return !isAborted();
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
  config: DevServerConfig,
  ctx: ServerContext,
  state: StartState,
  onSpawned?: () => void,
): Promise<void> {
  for (const server of config.servers) {
    console.log(`Starting ${server.name} dev server...`);
    if (server.kind === "spawn") {
      state.spawnPids[server.name] = spawnServer(server, config.runtimeDir, ctx.cwd);
    } else {
      try {
        await server.start(ctx);
      } catch (err) {
        throw toCallbackStartupError(server.name, err);
      }
      state.startedCallbacks.push(server);
    }
  }
  onSpawned?.();

  const spawnEntries = config.servers.filter((s): s is SpawnServer => s.kind === "spawn");
  const pollables: PollableServer[] = spawnEntries.map((s) => ({
    name: s.name,
    logFile: logFileFor(ctx.cwd, config.runtimeDir, s.name),
    detectReady: s.detectReady,
    detectError: s.detectError ?? detectCommonJsError,
  }));
  const pollPids = spawnEntries.map((s) => state.spawnPids[s.name]);
  await awaitAllReady(pollables, pollPids);
}

function registerStartedServer(
  mainWorktree: string,
  registryDir: string,
  workspace: ResolvedWorkspace,
  spawnPids: Record<string, number>,
): void {
  const devEntry: DevServerEntry = {
    name: workspace.name,
    worktree: workspace.worktree,
    pids: spawnPids,
    startedAt: new Date().toISOString(),
  };
  if (workspace.main) devEntry.main = true;
  registerDevServer(mainWorktree, registryDir, devEntry);
}

function printStartSummary(
  config: DevServerConfig,
  workspace: ResolvedWorkspace,
  servers: ResolvedServerDescriptor[],
  spawnPids: Record<string, number>,
): void {
  const summaryServers = servers.map((server) => {
    if (server.kind === "spawn") {
      return { server, port: server.port, pid: spawnPids[server.name] };
    }
    return { server };
  });
  if (config.formatSummary) {
    console.log(config.formatSummary({ workspace, servers: summaryServers }));
  } else {
    defaultPrintSummary(workspace, summaryServers, config.runtimeDir);
  }
}

const LIVENESS_POLL_MS = 1000;

// `fromStart` follows from the first byte (fresh start); `replayLines` prints the last N lines of
// an existing log before following (attaching to a running server).
type TailMode = { fromStart: true } | { replayLines: number };

function tailLogs(
  config: DevServerConfig,
  cwd: string,
  spawnPids: Record<string, number>,
  mode: TailMode,
): void {
  const names = Object.keys(spawnPids);
  const prefixed = names.length > 1;
  for (const name of names) {
    const path = logFileFor(cwd, config.runtimeDir, name);
    const prefix = prefixed ? `[${name}] ` : "";
    const offset = "fromStart" in mode ? 0 : replayTail(path, prefix, mode.replayLines);
    followLogFile(path, prefix, offset);
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
): Promise<void> {
  console.error("\nStopping dev servers...");
  for (const pid of Object.values(spawnPids)) {
    try {
      await stopProcessGroup(pid);
    } catch (err) {
      console.error(`  Failed to stop PID ${pid}: ${(err as Error).message}`);
    }
  }
  for (const server of [...startedCallbacks].reverse()) {
    console.log(`Stopping ${server.name}...`);
    try {
      await server.stop(ctx);
    } catch (err) {
      console.error(`  Failed to stop ${server.name}: ${(err as Error).message}`);
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
  if (livePids.length === 0) return false;

  if (restart) {
    console.log("Restarting dev-server in this worktree...");
    await stopLocal(kernel);
    return false;
  }

  const pidList = livePids.map(([name, pid]) => `${name}=${pid}`).join(", ");
  console.log(
    `dev-server already running for this worktree (workspace ${entry.name}, pids: ${pidList}).`,
  );
  console.log(`Run \`${devCmd("down")}\` to stop it, or re-run with \`--restart\` to restart.`);
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
  const active = pruneAndPersist(mainWorktree, registryDir).servers;
  if (active.length < limit) return;

  if (!evict) {
    console.error(`Error: dev-server cap reached (${active.length}/${limit}). Active dev-servers:`);
    printActiveServers(active);
    console.error(`Run \`${devCmd("down")}\` in another worktree, or \`${devCmd("down --all")}\`.`);
    console.error("Re-run with `--evict` to evict the oldest.");
    process.exit(1);
  }

  const toEvict = active.length - limit + 1;
  console.log(`Evicting ${toEvict} dev-server(s) to make room (cap ${limit}).`);
  const evicted = await evictOldest({
    mainWorktree,
    registryDir,
    callbackServers: callbackServersOf(config),
    portsOf: portsLookup(kernel),
    count: toEvict,
  });
  for (const entry of evicted) {
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    console.log(
      `Evicted workspace ${entry.name} (branch=${branch}, startedAt=${entry.startedAt}).`,
    );
  }
}

/** `pins`: the main worktree's pinned ports, by name; empty in a linked workspace. */
async function checkPortsFree(
  servers: ResolvedServerDescriptor[],
  cwd: string,
  pins: Record<string, number>,
): Promise<void> {
  const conflicts = await detectPortConflicts(servers, canonicalCwd(cwd));
  const foreign = conflicts.filter(
    (c): c is Extract<PortConflict, { kind: "foreign" }> => c.kind === "foreign",
  );
  if (foreign.length > 0) {
    for (const c of foreign) console.error(foreignHolderMessage(c, pins));
    process.exit(1);
  }
  const ours = conflicts.filter(
    (c): c is Extract<PortConflict, { kind: "ours" }> => c.kind === "ours",
  );
  if (ours.length === 0) return;
  for (const c of ours) {
    console.warn(
      `Stale ${c.server.name} dev-server detected on port ${c.server.port} (PID ${c.holder.pid}: ${c.holder.cmd}). Cleaning up...`,
    );
    if (c.holder.pgid === undefined) {
      console.error(`  Cannot kill: pgid unknown for PID ${c.holder.pid}.`);
      process.exit(1);
    }
    await stopProcessGroup(c.holder.pgid);
  }
  const stillBusy = await waitForPortsFree(
    ours.map((c) => c.server.port),
    2000,
  );
  if (stillBusy.length > 0) {
    for (const port of stillBusy) {
      const server = ours.find((c) => c.server.port === port)?.server;
      console.error(
        `Error: Port ${port}${server ? ` (${server.name})` : ""} still in use after cleanup attempt.`,
      );
    }
    process.exit(1);
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

function checkNoLocalRegistryConflict(
  mainWorktree: string,
  registryDir: string,
  cwd: string,
): void {
  const entry = findOwnEntry(mainWorktree, registryDir, cwd);
  if (!entry) return;
  for (const [name, pid] of Object.entries(entry.pids)) {
    if (isProcessAlive(pid)) {
      console.error(`Error: ${name} is already running (PID ${pid}).`);
      process.exit(1);
    }
  }
  // Stale entry — drop it so registration overwrites cleanly.
  removeDevServerEntryByWorktree(mainWorktree, registryDir, cwd);
}

async function stopLocal(kernel: DevKernel): Promise<void> {
  const { config, registryDir } = kernel;
  const { mainWorktree, currentWorktree } = kernel.worktree;
  const entry = findOwnEntry(mainWorktree, registryDir, currentWorktree);
  const cwd = entry?.worktree ?? currentWorktree;
  const ports = portsLookup(kernel)(cwd);
  const servers = resolveSpawnPorts(config.servers, ports);
  if (!entry) {
    console.log("No dev-server running in this worktree.");
    await sweepStalePorts(servers, cwd);
    return;
  }
  const ctx: ServerContext = { name: entry.name, cwd, ports };
  for (const [name, pid] of Object.entries(entry.pids)) {
    if (!isProcessAlive(pid)) continue;
    console.log(`Stopping ${name} (PID ${pid})...`);
    await stopProcessGroup(pid);
  }
  const callbacks = callbackServersOf(config);
  for (const server of [...callbacks].reverse()) {
    console.log(`Stopping ${server.name}...`);
    try {
      await server.stop(ctx);
    } catch (err) {
      console.error(`  Failed to stop ${server.name}: ${(err as Error).message}`);
    }
  }
  unregisterDevServer(mainWorktree, registryDir, ctx.cwd);
  await sweepStalePorts(servers, ctx.cwd);
}

function defaultPrintSummary(
  workspace: ResolvedWorkspace,
  servers: DevServerSummaryContext["servers"],
  runtimeDir: string,
): void {
  console.log("\nDev servers started!");
  console.log(`  Workspace: ${workspace.name}`);
  for (const { server, port, pid } of servers) {
    if (server.kind !== "spawn") {
      console.log(`  ${server.name}: ready`);
      continue;
    }
    const target = port === undefined ? `PID ${pid}` : `http://localhost:${port}/  (PID ${pid})`;
    console.log(`  ${server.name}: ${target}`);
    console.log(`    log: ${logFileFor(workspace.worktree, runtimeDir, server.name)}`);
  }
  console.log("");
}

function spawnServer(server: SpawnServer, runtimeDir: string, cwd: string): number {
  const logFile = logFileFor(cwd, runtimeDir, server.name);
  mkdirSync(dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, "w");
  const child = spawn(server.exec.command, server.exec.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd,
  });
  if (child.pid === undefined) {
    closeSync(logFd);
    console.error(`Error: failed to spawn ${server.name}.`);
    process.exit(1);
  }
  child.unref();
  closeSync(logFd);
  return child.pid;
}
