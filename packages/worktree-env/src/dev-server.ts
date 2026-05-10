import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import {
  parseDevServerArgs,
  printDevServerHelp,
  validateDevServerFlags,
  type DevServerArgs,
} from "./cli.js";
import { readDevLimit } from "./dev-limit.js";
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

export type PortConfig = { file: string; var: string } | { file: string; jsonPath: string };

export interface DevServerConfig {
  basePort: number;
  devLimitEnvVar: string;
  defaultLimit?: number;
  servers: ServerDescriptor[];
  ensureInfrastructure?: () => Promise<void> | void;
  printSummary?: (ctx: DevServerSummaryContext) => string;
}

export interface ServerDescriptor {
  name: string;
  command: string;
  args: string[];
  pidFile: string;
  logFile: string;
  detectSuccess: (logContent: string) => boolean;
  detectError?: (logContent: string) => string | false;
  portConfig: PortConfig;
}

export interface DevServerSummaryContext {
  slot: ResolvedSlot;
  servers: { server: ServerDescriptor; port: number; pid: number }[];
}

function readEnvFileVar(filePath: string, varName: string): string {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(new RegExp(`^${varName}=(.+)`, "m"));
  if (!match) {
    console.error(`Error: ${varName} not found in ${filePath}.`);
    process.exit(1);
  }
  return match[1].trim();
}

function readJsonPath(filePath: string, jsonPath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);
  const segments = jsonPath.split(".");
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      console.error(`Error: ${jsonPath} not found in ${filePath}.`);
      process.exit(1);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined || cur === null) {
    console.error(`Error: ${jsonPath} not found in ${filePath}.`);
    process.exit(1);
  }
  return String(cur);
}

function readPortFromConfig(portConfig: PortConfig): number {
  if (!existsSync(portConfig.file)) {
    console.error(`Error: ${portConfig.file} not found. Run setup-worktree first.`);
    process.exit(1);
  }
  const raw =
    "var" in portConfig
      ? readEnvFileVar(portConfig.file, portConfig.var)
      : readJsonPath(portConfig.file, portConfig.jsonPath);
  const port = Number(raw);
  if (!Number.isFinite(port)) {
    console.error(`Error: invalid port "${raw}" in ${portConfig.file}.`);
    process.exit(1);
  }
  return port;
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
  const logFd = openSync(server.logFile, "w");
  const child = spawn(server.command, server.args, {
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
  const limit = readDevLimit({
    projectVar: config.devLimitEnvVar,
    defaultLimit: config.defaultLimit,
  });
  const active = pruneAndPersist(mainWorktree).servers;
  if (limit > 0 && active.length >= limit) {
    console.error(`Error: dev-server cap reached (${active.length}/${limit}). Active dev-servers:`);
    printActiveServers(active);
    console.error("Run `dev:down` in another worktree, or `dev:down --all`.");
    process.exit(1);
  }

  const serverPorts: [ServerDescriptor, number][] = config.servers.map((server) => [
    server,
    readPortFromConfig(server.portConfig),
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
  console.log(`  Worktree: slot ${slot.slot}, owner ${slot.owner}`);
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
