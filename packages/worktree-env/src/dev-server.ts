import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import {
  parseDevServerArgs,
  printDevServerHelp,
  validateDevServerFlags,
  type DevServerArgs,
} from "./cli.js";
import {
  type DevServerEntry,
  evictOldest,
  findOwnEntry,
  listDevServers,
  printActiveServers,
  pruneAndPersist,
  registerDevServer,
  removeDevServerEntryByWorktree,
  stopAllRegistered,
  unregisterDevServer,
} from "./dev-servers-registry.js";
import { ConfigError, StartupError } from "./errors.js";
import { detectCommonJsError } from "./helpers.js";
import { awaitAllReady, handleStartupFailure, type PollableServer } from "./log-polling.js";
import { canonicalCwd, findPortHolder, isPidOurs, sweepStalePorts } from "./port-holder.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import type {
  CallbackServer,
  ServerContext,
  ServerDescriptor,
  SpawnServer,
} from "./server-descriptor.js";
import { resolveCurrentSlot, type ResolvedSlot } from "./slots.js";
import { detectWorktree } from "./worktree.js";

export type { CallbackServer, ServerContext, ServerDescriptor, SpawnServer };

/** Configuration accepted by {@link runDevServer}. */
export interface DevServerConfig {
  /** Anchor port for the slot range. Used to synthesize the main worktree's slot. */
  basePort: number;
  /** Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`). */
  runtimeDir: string;
  /**
   * Shared registry directory, relative to a worktree root (e.g. `.local/wt-registry`).
   * Holds `slots.json` and `dev-servers.json`. Must resolve to the same physical directory
   * across linked worktrees — typically via a symlink (e.g. `.local`).
   */
  registryDir: string;
  /** Maximum concurrent dev-servers across all worktrees. Omit for no limit. */
  devLimit?: number;
  /** One entry per server to start. Started in array order; stopped in reverse order. */
  servers: ServerDescriptor[];
  /** Builds the post-start summary printed to stdout. Defaults to a generic layout. */
  printSummary?: (ctx: DevServerSummaryContext) => string;
}

function logFileFor(runtimeDir: string, name: string): string {
  return join(runtimeDir, "logs", `${name}.log`);
}

/**
 * Context passed to {@link DevServerConfig.printSummary}. `port` and `pid` are present only for
 * `kind: "spawn"` servers; callback servers expose neither.
 */
export interface DevServerSummaryContext {
  slot: ResolvedSlot;
  servers: { server: ServerDescriptor; port?: number; pid?: number }[];
}

export async function runDevServer(config: DevServerConfig): Promise<void> {
  let args: DevServerArgs;
  try {
    args = parseDevServerArgs();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (args.help) {
    printDevServerHelp();
    return;
  }

  try {
    validateDevServerFlags(args);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }

  const { mainWorktree } = detectWorktree();

  if (args.list) {
    listDevServers(mainWorktree, config.registryDir);
    return;
  }
  if (args.stop && args.all) {
    await stopAllRegistered({
      mainWorktree,
      registryDir: config.registryDir,
      callbackServers: callbackServersOf(config),
    });
    return;
  }
  if (args.stop) {
    await stopLocal(config, mainWorktree);
    return;
  }

  await start(config, mainWorktree, {
    evict: Boolean(args.evict),
    restart: Boolean(args.restart),
  });
}

function callbackServersOf(config: DevServerConfig): CallbackServer[] {
  return config.servers.filter((s): s is CallbackServer => s.kind === "callback");
}

async function start(
  config: DevServerConfig,
  mainWorktree: string,
  { evict, restart }: { evict: boolean; restart: boolean },
): Promise<void> {
  const ctx: ServerContext = { cwd: process.cwd() };

  if (await handleAlreadyRunning(config, mainWorktree, ctx, restart)) return;
  await enforceCap(config, mainWorktree, evict);
  checkNoLocalRegistryConflict(config, mainWorktree, ctx.cwd);
  await checkPortsFree(config.servers, ctx.cwd);

  const spawnPids: Record<string, number> = {};
  const startedCallbacks: CallbackServer[] = [];

  try {
    for (const server of config.servers) {
      console.log(`Starting ${server.name} dev server...`);
      if (server.kind === "spawn") {
        spawnPids[server.name] = spawnServer(server, config.runtimeDir, ctx.cwd);
      } else {
        await server.start(ctx);
        startedCallbacks.push(server);
      }
    }

    const spawnEntries = config.servers.filter((s): s is SpawnServer => s.kind === "spawn");
    const pollables: PollableServer[] = spawnEntries.map((s) => ({
      name: s.name,
      logFile: logFileFor(config.runtimeDir, s.name),
      detectSuccess: s.detectSuccess,
      detectError: s.detectError ?? detectCommonJsError,
    }));
    const pollPids = spawnEntries.map((s) => spawnPids[s.name]);
    await awaitAllReady(pollables, pollPids);
  } catch (err) {
    await rollbackStart(spawnPids, startedCallbacks, ctx);
    if (err instanceof StartupError) {
      handleStartupFailure(err);
      process.exit(1);
    }
    throw err;
  }

  const slot = resolveCurrentSlot(config.basePort, config.registryDir);
  const devEntry: DevServerEntry = {
    slot: slot.slot,
    worktree: slot.worktree,
    branch: slot.branch,
    owner: slot.owner,
    pids: spawnPids,
    startedAt: new Date().toISOString(),
  };
  if (slot.main) devEntry.main = true;
  registerDevServer(mainWorktree, config.registryDir, devEntry);

  const summaryServers = config.servers.map((server) => {
    if (server.kind === "spawn") {
      return { server, port: server.port, pid: spawnPids[server.name] };
    }
    return { server };
  });

  if (config.printSummary) {
    console.log(config.printSummary({ slot, servers: summaryServers }));
  } else {
    defaultPrintSummary(slot, summaryServers, config.runtimeDir);
  }
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
  config: DevServerConfig,
  mainWorktree: string,
  ctx: ServerContext,
  restart: boolean,
): Promise<boolean> {
  const entry = findOwnEntry(mainWorktree, config.registryDir, ctx.cwd);
  if (!entry) return false;
  const livePids = Object.entries(entry.pids).filter(([, pid]) => isProcessAlive(pid));
  if (livePids.length === 0) return false;

  if (restart) {
    console.log("Restarting dev-server in this worktree...");
    await stopLocal(config, mainWorktree);
    return false;
  }

  const pidList = livePids.map(([name, pid]) => `${name}=${pid}`).join(", ");
  console.log(
    `dev-server already running for this worktree (slot ${entry.slot}, pids: ${pidList}).`,
  );
  console.log("Run `dev:down` to stop it, or re-run with --restart to restart.");
  return true;
}

// TOCTOU: the cap check and the subsequent register are not atomic. Two concurrent `dev:up --evict`
// from different worktrees can both pass the cap check and both register, exceeding the limit by
// one. Accepted: the race window is narrow and the consequence is bounded (one extra dev-server).
async function enforceCap(
  config: DevServerConfig,
  mainWorktree: string,
  evict: boolean,
): Promise<void> {
  const limit = config.devLimit;
  if (limit === undefined) return;
  const active = pruneAndPersist(mainWorktree, config.registryDir).servers;
  if (active.length < limit) return;

  if (!evict) {
    console.error(`Error: dev-server cap reached (${active.length}/${limit}). Active dev-servers:`);
    printActiveServers(active);
    console.error("Run `dev:down` in another worktree, or `dev:down --all`.");
    console.error("Re-run with --evict to evict the oldest.");
    process.exit(1);
  }

  const toEvict = active.length - limit + 1;
  console.log(`Evicting ${toEvict} dev-server(s) to make room (cap ${limit}).`);
  const evicted = await evictOldest({
    mainWorktree,
    registryDir: config.registryDir,
    callbackServers: callbackServersOf(config),
    count: toEvict,
  });
  for (const entry of evicted) {
    const ownerPart = entry.owner ? `, owner=${entry.owner}` : "";
    console.log(
      `Evicted slot ${entry.slot} (branch=${entry.branch}${ownerPart}, startedAt=${entry.startedAt}).`,
    );
  }
}

async function checkPortsFree(servers: ServerDescriptor[], cwd: string): Promise<void> {
  const spawnServers = servers.filter((s): s is SpawnServer => s.kind === "spawn");
  const ourCwd = canonicalCwd(cwd);
  let cleaned = false;
  for (const server of spawnServers) {
    if (!(await isPortBusy(server.port))) continue;
    const holder = findPortHolder(server.port);
    if (holder && isPidOurs(holder, ourCwd)) {
      console.warn(
        `Stale ${server.name} dev-server detected on port ${server.port} (PID ${holder.pid}: ${holder.cmd}). Cleaning up...`,
      );
      await stopProcessGroup(holder.pgid);
      cleaned = true;
    } else {
      const info = holder
        ? ` (PID ${holder.pid}: ${holder.cmd}${holder.cwd ? `, cwd ${holder.cwd}` : ""})`
        : "";
      console.error(`Error: Port ${server.port} (${server.name}) is already in use${info}.`);
      process.exit(1);
    }
  }
  if (!cleaned) return;
  await new Promise((r) => setTimeout(r, 500));
  for (const server of spawnServers) {
    if (await isPortBusy(server.port)) {
      console.error(
        `Error: Port ${server.port} (${server.name}) still in use after cleanup attempt.`,
      );
      process.exit(1);
    }
  }
}

function checkNoLocalRegistryConflict(
  config: DevServerConfig,
  mainWorktree: string,
  cwd: string,
): void {
  const entry = findOwnEntry(mainWorktree, config.registryDir, cwd);
  if (!entry) return;
  for (const [name, pid] of Object.entries(entry.pids)) {
    if (isProcessAlive(pid)) {
      console.error(`Error: ${name} is already running (PID ${pid}).`);
      process.exit(1);
    }
  }
  // Stale entry — drop it so registration overwrites cleanly.
  removeDevServerEntryByWorktree(mainWorktree, config.registryDir, cwd);
}

async function stopLocal(config: DevServerConfig, mainWorktree: string): Promise<void> {
  const ctx: ServerContext = { cwd: process.cwd() };
  const entry = findOwnEntry(mainWorktree, config.registryDir, ctx.cwd);
  if (!entry) {
    console.log("No dev-server running in this worktree.");
    await sweepStalePorts(config.servers, ctx.cwd);
    return;
  }
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
  unregisterDevServer(mainWorktree, config.registryDir, ctx.cwd);
  await sweepStalePorts(config.servers, ctx.cwd);
}

function defaultPrintSummary(
  slot: ResolvedSlot,
  servers: DevServerSummaryContext["servers"],
  runtimeDir: string,
): void {
  console.log("\nDev servers started!");
  const ownerSuffix = slot.owner ? `, owner ${slot.owner}` : "";
  console.log(`  Worktree: slot ${slot.slot}${ownerSuffix}`);
  for (const { server, port, pid } of servers) {
    if (server.kind === "spawn") {
      const url = `http://localhost:${port}/`;
      const logPath = join(process.cwd(), logFileFor(runtimeDir, server.name));
      console.log(`  ${server.name}: ${url}  (PID ${pid})`);
      console.log(`    log: ${logPath}`);
    } else {
      console.log(`  ${server.name}: ready`);
    }
  }
  console.log("");
}

function spawnServer(server: SpawnServer, runtimeDir: string, cwd: string): number {
  const logFile = logFileFor(runtimeDir, server.name);
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

function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
