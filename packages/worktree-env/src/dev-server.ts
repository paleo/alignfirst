import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import {
  parseDevServerArgs,
  printDevServerHelp,
  validateDevServerFlags,
  type DevServerArgs,
} from "./cli.js";
import {
  evictOldest,
  listDevServers,
  printActiveServers,
  pruneAndPersist,
  registerDevServer,
  stopAllRegistered,
  unregisterDevServer,
} from "./dev-servers-registry.js";
import { ConfigError, StartupError } from "./errors.js";
import { awaitAllReady, handleStartupFailure, type PollableServer } from "./log-polling.js";
import { cleanupPidFile, isProcessAlive, readPid, stopByPidFile } from "./process-control.js";
import { resolveCurrentSlot, type ResolvedSlot } from "./slots.js";
import { detectWorktree } from "./worktree.js";

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
  /** One entry per process to spawn. Started in array order. */
  servers: ServerDescriptor[];
  /** Hook invoked once before any dev-server is spawned (e.g. `docker compose up -d`). */
  ensureInfrastructure?: () => Promise<void> | void;
  /** Builds the post-start summary printed to stdout. Defaults to a generic layout. */
  printSummary?: (ctx: DevServerSummaryContext) => string;
}

/** Describes one process to spawn. */
export interface ServerDescriptor {
  /** Short label used in logs and the registry. Derives `<runtimeDir>/<name>.pid` and `<runtimeDir>/logs/<name>.log`. */
  name: string;
  /** Command and arguments passed to `child_process.spawn`. */
  exec: { command: string; args: string[] };
  /** Port the process will listen on. Use `helpers.readPortFromEnvFile` / `readPortFromJsonFile` to read it from a config file. */
  port: number;
  /** Returns `true` once the log content indicates the server is ready. */
  detectSuccess: (logContent: string) => boolean;
  /** Returns a non-empty marker string when the log content indicates a fatal error, or `false` otherwise. */
  detectError?: (logContent: string) => string | false;
}

function pidFileFor(runtimeDir: string, name: string): string {
  return join(runtimeDir, `${name}.pid`);
}

function logFileFor(runtimeDir: string, name: string): string {
  return join(runtimeDir, "logs", `${name}.log`);
}

/** Context passed to {@link DevServerConfig.printSummary}. */
export interface DevServerSummaryContext {
  slot: ResolvedSlot;
  servers: { server: ServerDescriptor; port: number; pid: number }[];
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
      runtimeDir: config.runtimeDir,
    });
    return;
  }
  if (args.stop) {
    await stopLocal(config, mainWorktree);
    return;
  }

  await start(config, mainWorktree, { evict: Boolean(args.evict) });
}

async function start(
  config: DevServerConfig,
  mainWorktree: string,
  { evict }: { evict: boolean },
): Promise<void> {
  await enforceCap(config, mainWorktree, evict);
  await checkPortsFree(config.servers);
  checkNoLocalPidConflict(config);

  if (config.ensureInfrastructure) await config.ensureInfrastructure();

  const pids: number[] = [];
  for (const server of config.servers) {
    console.log(`Starting ${server.name} dev server...`);
    pids.push(spawnServer(server, config.runtimeDir));
  }

  try {
    const pollables: PollableServer[] = config.servers.map((s) => ({
      name: s.name,
      logFile: logFileFor(config.runtimeDir, s.name),
      detectSuccess: s.detectSuccess,
      detectError: s.detectError,
    }));
    await awaitAllReady(pollables, pids);
  } catch (err) {
    if (err instanceof StartupError) {
      handleStartupFailure(err);
      console.error("\nStopping dev servers...");
      await stopLocal(config, mainWorktree);
      process.exit(1);
    }
    throw err;
  }

  const slot = resolveCurrentSlot(config.basePort, config.registryDir);
  const pidMap: Record<string, number> = {};
  config.servers.forEach((server, i) => {
    pidMap[server.name] = pids[i];
  });
  registerDevServer(mainWorktree, config.registryDir, {
    slot: slot.slot,
    worktree: slot.worktree,
    branch: slot.branch,
    owner: slot.owner,
    pids: pidMap,
    startedAt: new Date().toISOString(),
  });

  if (config.printSummary) {
    console.log(
      config.printSummary({
        slot,
        servers: config.servers.map((server, i) => ({
          server,
          port: server.port,
          pid: pids[i],
        })),
      }),
    );
  } else {
    defaultPrintSummary(
      slot,
      config.servers,
      config.servers.map((s) => s.port),
      pids,
      config.runtimeDir,
    );
  }
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
  const evicted = await evictOldest(mainWorktree, config.registryDir, toEvict);
  for (const entry of evicted) {
    const ownerPart = entry.owner ? `, owner=${entry.owner}` : "";
    console.log(
      `Evicted slot ${entry.slot} (branch=${entry.branch}${ownerPart}, startedAt=${entry.startedAt}).`,
    );
    for (const name of Object.keys(entry.pids)) {
      cleanupPidFile(join(entry.worktree, config.runtimeDir, `${name}.pid`));
    }
  }
}

async function checkPortsFree(servers: ServerDescriptor[]): Promise<void> {
  const busy = await Promise.all(servers.map((s) => isPortBusy(s.port)));
  let anyBusy = false;
  busy.forEach((b, i) => {
    if (b) {
      console.error(`Error: Port ${servers[i].port} (${servers[i].name}) is already in use.`);
      anyBusy = true;
    }
  });
  if (anyBusy) process.exit(1);
}

function checkNoLocalPidConflict(config: DevServerConfig): void {
  for (const server of config.servers) {
    const pidFile = pidFileFor(config.runtimeDir, server.name);
    const existingPid = readPid(pidFile);
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      console.error(`Error: ${server.name} is already running (PID ${existingPid}).`);
      process.exit(1);
    }
    cleanupPidFile(pidFile);
  }
}

async function stopLocal(config: DevServerConfig, mainWorktree: string): Promise<void> {
  for (const server of config.servers) {
    await stopByPidFile(pidFileFor(config.runtimeDir, server.name), server.name, (msg) =>
      console.log(msg),
    );
  }
  unregisterDevServer(mainWorktree, config.registryDir, process.cwd());
}

function defaultPrintSummary(
  slot: ResolvedSlot,
  servers: ServerDescriptor[],
  ports: number[],
  pids: number[],
  runtimeDir: string,
): void {
  console.log("\nDev servers started!");
  const ownerSuffix = slot.owner ? `, owner ${slot.owner}` : "";
  console.log(`  Worktree: slot ${slot.slot}${ownerSuffix}`);
  servers.forEach((server, i) => {
    const url = `http://localhost:${ports[i]}/`;
    const logPath = join(process.cwd(), logFileFor(runtimeDir, server.name));
    console.log(`  ${server.name}: ${url}  (PID ${pids[i]})`);
    console.log(`    log: ${logPath}`);
  });
  console.log("");
}

function spawnServer(server: ServerDescriptor, runtimeDir: string): number {
  const logFile = logFileFor(runtimeDir, server.name);
  const pidFile = pidFileFor(runtimeDir, server.name);
  mkdirSync(dirname(logFile), { recursive: true });
  mkdirSync(dirname(pidFile), { recursive: true });
  const logFd = openSync(logFile, "w");
  const child = spawn(server.exec.command, server.exec.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid === undefined) {
    closeSync(logFd);
    console.error(`Error: failed to spawn ${server.name}.`);
    process.exit(1);
  }
  writeFileSync(pidFile, String(child.pid));
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
