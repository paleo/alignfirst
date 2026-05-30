import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { type DevCommand, parseDevArgs, printDevHelp } from "./cli.js";
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
import { detectCommonJsError, formatDuration, setupLogPath } from "./helpers.js";
import { awaitAllReady, handleStartupFailure, type PollableServer } from "./log-polling.js";
import {
  canonicalCwd,
  detectPortConflicts,
  type PortConflict,
  sweepStalePorts,
  waitForPortsFree,
} from "./port-holder.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import type {
  CallbackServer,
  ServerContext,
  ServerDescriptor,
  SpawnServer,
} from "./server-descriptor.js";
import { readSlots, resolveCurrentSlot, type ResolvedSlot, type SlotEntry } from "./slots.js";
import { detectWorktree, getWorktreeBranch } from "./worktree.js";

export type { CallbackServer, ServerContext, ServerDescriptor, SpawnServer };

/** Configuration accepted by {@link runDevServer}. */
export interface DevServerConfig {
  /** Anchor port for the slot range. Used to synthesize the main worktree's slot. */
  basePort: number;
  /** Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`). */
  runtimeDir: string;
  /**
   * Shared registry directory, relative to a worktree root (e.g. `.local/_workspace-registry`).
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

  const { mainWorktree } = detectWorktree();

  switch (command.kind) {
    case "list":
      listDevServers(mainWorktree, config.registryDir);
      return;
    case "down":
      if (command.all) {
        await stopAllRegistered({
          mainWorktree,
          registryDir: config.registryDir,
          callbackServers: callbackServersOf(config),
        });
      } else {
        await stopLocal(config, mainWorktree);
      }
      return;
    case "up":
      await start(config, mainWorktree, { evict: command.evict, restart: command.restart });
      return;
    case "foreground":
      await runForeground(config, mainWorktree, {
        evict: command.evict,
        restart: command.restart,
      });
      return;
  }
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

async function start(
  config: DevServerConfig,
  mainWorktree: string,
  options: StartOptions,
): Promise<void> {
  const ctx: ServerContext = { cwd: process.cwd() };
  if (await runStartChecks(config, mainWorktree, ctx, options)) return;

  const state: StartState = { spawnPids: {}, startedCallbacks: [] };
  try {
    await spawnAndAwait(config, ctx, state);
  } catch (err) {
    await rollbackStart(state.spawnPids, state.startedCallbacks, ctx);
    if (err instanceof StartupError) {
      handleStartupFailure(err);
      process.exit(1);
    }
    throw err;
  }

  const slot = registerStartedServer(config, mainWorktree, state.spawnPids);
  printStartSummary(config, slot, state.spawnPids);
}

/**
 * Foreground start: hold the terminal and tail logs until CTRL+C, then stop cleanly. Signal
 * handlers are installed before starting so an interrupt during startup rolls back; after a
 * successful start they switch to the local stop sequence.
 */
async function runForeground(
  config: DevServerConfig,
  mainWorktree: string,
  options: StartOptions,
): Promise<void> {
  const ctx: ServerContext = { cwd: process.cwd() };
  const state: StartState = { spawnPids: {}, startedCallbacks: [] };
  let started = false;
  let shuttingDown = false;

  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (started) {
      void shutdownForeground(config, mainWorktree);
    } else {
      void rollbackStart(state.spawnPids, state.startedCallbacks, ctx).then(() =>
        process.exit(130),
      );
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (await runStartChecks(config, mainWorktree, ctx, options)) process.exit(0);

  try {
    await spawnAndAwait(config, ctx, state);
  } catch (err) {
    await rollbackStart(state.spawnPids, state.startedCallbacks, ctx);
    if (err instanceof StartupError) {
      handleStartupFailure(err);
      process.exit(1);
    }
    throw err;
  }

  const slot = registerStartedServer(config, mainWorktree, state.spawnPids);
  started = true;
  printStartSummary(config, slot, state.spawnPids);
  tailLogs(config, state.spawnPids);
  await new Promise<never>(() => {});
}

async function shutdownForeground(config: DevServerConfig, mainWorktree: string): Promise<void> {
  console.log("\nStopping dev servers...");
  await stopLocal(config, mainWorktree);
  console.log("Stopped.");
  process.exit(0);
}

async function runStartChecks(
  config: DevServerConfig,
  mainWorktree: string,
  ctx: ServerContext,
  { evict, restart }: StartOptions,
): Promise<boolean> {
  checkWorktreeReady(config, mainWorktree, ctx.cwd);
  if (await handleAlreadyRunning(config, mainWorktree, ctx, restart)) return true;
  await enforceCap(config, mainWorktree, evict);
  checkNoLocalRegistryConflict(config, mainWorktree, ctx.cwd);
  await checkPortsFree(config.servers, ctx.cwd);
  return false;
}

async function spawnAndAwait(
  config: DevServerConfig,
  ctx: ServerContext,
  state: StartState,
): Promise<void> {
  for (const server of config.servers) {
    console.log(`Starting ${server.name} dev server...`);
    if (server.kind === "spawn") {
      state.spawnPids[server.name] = spawnServer(server, config.runtimeDir, ctx.cwd);
    } else {
      await server.start(ctx);
      state.startedCallbacks.push(server);
    }
  }

  const spawnEntries = config.servers.filter((s): s is SpawnServer => s.kind === "spawn");
  const pollables: PollableServer[] = spawnEntries.map((s) => ({
    name: s.name,
    logFile: logFileFor(config.runtimeDir, s.name),
    detectSuccess: s.detectSuccess,
    detectError: s.detectError ?? detectCommonJsError,
  }));
  const pollPids = spawnEntries.map((s) => state.spawnPids[s.name]);
  await awaitAllReady(pollables, pollPids);
}

function registerStartedServer(
  config: DevServerConfig,
  mainWorktree: string,
  spawnPids: Record<string, number>,
): ResolvedSlot {
  const slot = resolveCurrentSlot(config.basePort, config.registryDir);
  const devEntry: DevServerEntry = {
    slot: slot.slot,
    worktree: slot.worktree,
    owner: slot.owner,
    pids: spawnPids,
    startedAt: new Date().toISOString(),
  };
  if (slot.main) devEntry.main = true;
  registerDevServer(mainWorktree, config.registryDir, devEntry);
  return slot;
}

function printStartSummary(
  config: DevServerConfig,
  slot: ResolvedSlot,
  spawnPids: Record<string, number>,
): void {
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

const TAIL_INTERVAL_MS = 300;

function tailLogs(config: DevServerConfig, spawnPids: Record<string, number>): void {
  const names = Object.keys(spawnPids);
  const prefixed = names.length > 1;
  for (const name of names) {
    const path = join(process.cwd(), logFileFor(config.runtimeDir, name));
    followLogFile(path, prefixed ? `[${name}] ` : "");
  }
}

function followLogFile(path: string, prefix: string): void {
  let offset = existsSync(path) ? statSync(path).size : 0;
  setInterval(() => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size <= offset) return;
    const length = size - offset;
    const fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    closeSync(fd);
    offset += bytesRead;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    process.stdout.write(prefix === "" ? text : text.replace(/^(?=.)/gm, prefix));
  }, TAIL_INTERVAL_MS);
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

export type WorktreeReadyCheck = { ok: true } | { ok: false; message: string };

/**
 * Pure builder for the `dev` worktree-readiness gate. Returns `ok` when the slot is `ready`
 * or absent (synthesized main); otherwise returns the user-facing error message.
 */
export function buildWorktreeReadyMessage(input: {
  slotPort: number;
  worktreePath: string;
  runtimeDir: string;
  entry: SlotEntry | undefined;
  now: number;
}): WorktreeReadyCheck {
  const { slotPort, worktreePath, runtimeDir, entry, now } = input;
  if (!entry || entry.status === "ready") return { ok: true };
  const logPath = setupLogPath(worktreePath, runtimeDir);
  if (entry.status === "pending") {
    const elapsed = formatDuration(now - Date.parse(entry.createdAt));
    return {
      ok: false,
      message:
        `Error: Worktree setup is still in progress (slot ${slotPort}, started ${elapsed} ago).\n` +
        `Tail: ${logPath}\n` +
        "Run `workspace wait` to block until it finishes, or retry `dev` once ready.",
    };
  }
  const failureAt = entry.failure?.at ?? entry.createdAt;
  const elapsed = formatDuration(now - Date.parse(failureAt));
  const reason = entry.failure?.message ?? "(no message)";
  return {
    ok: false,
    message:
      `Error: Worktree setup failed (slot ${slotPort}, ${elapsed} ago): ${reason}\n` +
      `Tail: ${logPath}\n` +
      "Re-run `workspace setup` to retry the finalize.",
  };
}

function checkWorktreeReady(config: DevServerConfig, mainWorktree: string, cwd: string): void {
  const slot = resolveCurrentSlot(config.basePort, config.registryDir);
  const entry = readSlots(mainWorktree, config.registryDir).slots[String(slot.slot)];
  const result = buildWorktreeReadyMessage({
    slotPort: slot.slot,
    worktreePath: cwd,
    runtimeDir: config.runtimeDir,
    entry,
    now: Date.now(),
  });
  if (result.ok) return;
  console.error(result.message);
  process.exit(1);
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
  console.log("Run `dev down` to stop it, or re-run with `--restart` to restart.");
  return true;
}

// TOCTOU: the cap check and the subsequent register are not atomic. Two concurrent `dev up --evict`
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
    console.error("Run `dev down` in another worktree, or `dev down --all`.");
    console.error("Re-run with `--evict` to evict the oldest.");
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
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    console.log(
      `Evicted slot ${entry.slot} (branch=${branch}${ownerPart}, startedAt=${entry.startedAt}).`,
    );
  }
}

async function checkPortsFree(servers: ServerDescriptor[], cwd: string): Promise<void> {
  const conflicts = await detectPortConflicts(servers, canonicalCwd(cwd));
  const foreign = conflicts.filter(
    (c): c is Extract<PortConflict, { kind: "foreign" }> => c.kind === "foreign",
  );
  if (foreign.length > 0) {
    for (const c of foreign) {
      const info = c.holder
        ? ` (PID ${c.holder.pid}: ${c.holder.cmd}${c.holder.cwd ? `, cwd ${c.holder.cwd}` : ""})`
        : "";
      console.error(`Error: Port ${c.server.port} (${c.server.name}) is already in use${info}.`);
    }
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
  console.log(`  Workspace: slot ${slot.slot}${ownerSuffix}`);
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
