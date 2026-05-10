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
  /** Short label used in logs and the registry. */
  name: string;
  /** Command and arguments passed to `child_process.spawn`. */
  exec: { command: string; args: string[] };
  /** Port the process will listen on. Use `helpers.readPortFromEnvFile` / `readPortFromJsonFile` to read it from a config file. */
  port: number;
  /** Path (relative to cwd) where the spawned PID is written. */
  pidFile: string;
  /** Path (relative to cwd) where stdout+stderr are tee'd. */
  logFile: string;
  /** Returns `true` once the log content indicates the server is ready. */
  detectSuccess: (logContent: string) => boolean;
  /** Returns a non-empty marker string when the log content indicates a fatal error, or `false` otherwise. */
  detectError?: (logContent: string) => string | false;
}

/** Context passed to {@link DevServerConfig.printSummary}. */
export interface DevServerSummaryContext {
  slot: ResolvedSlot;
  servers: { server: ServerDescriptor; port: number; pid: number }[];
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

function spawnServer(server: ServerDescriptor): number {
  mkdirSync(dirname(server.logFile), { recursive: true });
  mkdirSync(dirname(server.pidFile), { recursive: true });
  const logFd = openSync(server.logFile, "w");
  const child = spawn(server.exec.command, server.exec.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid === undefined) {
    closeSync(logFd);
    console.error(`Error: failed to spawn ${server.name}.`);
    process.exit(1);
  }
  writeFileSync(server.pidFile, String(child.pid));
  child.unref();
  closeSync(logFd);
  return child.pid;
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
    listDevServers(mainWorktree);
    return;
  }
  if (args.stop && args.all) {
    await stopAllRegistered({
      mainWorktree,
      pidFiles: config.servers.map((s) => s.pidFile),
    });
    return;
  }
  if (args.stop) {
    await stopLocal(config, mainWorktree);
    return;
  }

  await start(config, mainWorktree);
}

async function start(config: DevServerConfig, mainWorktree: string): Promise<void> {
  const limit = config.devLimit;
  const active = pruneAndPersist(mainWorktree).servers;
  if (limit !== undefined && active.length >= limit) {
    console.error(`Error: dev-server cap reached (${active.length}/${limit}). Active dev-servers:`);
    printActiveServers(active);
    console.error("Run `dev:down` in another worktree, or `dev:down --all`.");
    process.exit(1);
  }

  const serverPorts: [ServerDescriptor, number][] = config.servers.map((server) => [
    server,
    server.port,
  ]);

  const busyResults = await Promise.all(serverPorts.map(([, port]) => isPortBusy(port)));
  let anyBusy = false;
  busyResults.forEach((busy, i) => {
    if (busy) {
      const [server, port] = serverPorts[i];
      console.error(`Error: Port ${port} (${server.name}) is already in use.`);
      anyBusy = true;
    }
  });
  if (anyBusy) process.exit(1);

  for (const server of config.servers) {
    const existingPid = readPid(server.pidFile);
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      console.error(`Error: ${server.name} is already running (PID ${existingPid}).`);
      process.exit(1);
    }
    cleanupPidFile(server.pidFile);
  }

  if (config.ensureInfrastructure) await config.ensureInfrastructure();

  const pids: number[] = [];
  for (const server of config.servers) {
    console.log(`Starting ${server.name} dev server...`);
    pids.push(spawnServer(server));
  }

  try {
    const pollables: PollableServer[] = config.servers.map((s) => ({
      name: s.name,
      logFile: s.logFile,
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

  const slot = resolveCurrentSlot(config.basePort);
  const pidMap: Record<string, number> = {};
  config.servers.forEach((server, i) => {
    pidMap[server.name] = pids[i];
  });
  registerDevServer(mainWorktree, {
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
          port: serverPorts[i][1],
          pid: pids[i],
        })),
      }),
    );
  } else {
    defaultPrintSummary(
      slot,
      config.servers,
      serverPorts.map(([, p]) => p),
      pids,
    );
  }
}

function defaultPrintSummary(
  slot: ResolvedSlot,
  servers: ServerDescriptor[],
  ports: number[],
  pids: number[],
): void {
  console.log("\nDev servers started!");
  const ownerSuffix = slot.owner ? `, owner ${slot.owner}` : "";
  console.log(`  Worktree: slot ${slot.slot}${ownerSuffix}`);
  servers.forEach((server, i) => {
    const url = `http://localhost:${ports[i]}/`;
    const logPath = join(process.cwd(), server.logFile);
    console.log(`  ${server.name}: ${url}  (PID ${pids[i]})`);
    console.log(`    log: ${logPath}`);
  });
  console.log("");
}

async function stopLocal(config: DevServerConfig, mainWorktree: string): Promise<void> {
  for (const server of config.servers) {
    await stopByPidFile(server.pidFile, server.name, (msg) => console.log(msg));
  }
  unregisterDevServer(mainWorktree, process.cwd());
}
