import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import type { CallbackServer } from "./server-descriptor.js";

const DEV_SERVERS_FILENAME = "dev-servers.json";

export interface DevServerEntry {
  slot: number;
  worktree: string;
  branch: string;
  owner?: string;
  pids: Record<string, number>;
  startedAt: string;
}

export interface DevServersData {
  servers: DevServerEntry[];
}

export type IsAliveFn = (pid: number) => boolean;

export function listDevServers(mainWorktree: string, registryDir: string): void {
  const data = pruneAndPersist(mainWorktree, registryDir);
  if (data.servers.length === 0) {
    console.log("No dev-servers running.");
    return;
  }
  const sorted = [...data.servers].sort((a, b) => a.slot - b.slot);
  for (const entry of sorted) {
    console.log(formatEntry(entry));
  }
}

export function printActiveServers(active: DevServerEntry[]): void {
  const sorted = [...active].sort((a, b) => a.slot - b.slot);
  for (const entry of sorted) {
    process.stderr.write(`${formatEntry(entry)}\n`);
  }
}

export interface StopAllInput {
  mainWorktree: string;
  registryDir: string;
  /** Callback-managed servers from the current process's config. Their `stop()` is invoked for each
   *  victim with `ctx.cwd = entry.worktree`. */
  callbackServers: CallbackServer[];
}

export async function stopAllRegistered(input: StopAllInput): Promise<void> {
  const data = pruneAndPersist(input.mainWorktree, input.registryDir);
  if (data.servers.length === 0) {
    console.log("No dev-servers running.");
    return;
  }
  for (const entry of data.servers) {
    const ownerSuffix = entry.owner ? `, owner=${entry.owner}` : "";
    console.log(`Stopping slot ${entry.slot} (${entry.branch}${ownerSuffix})...`);
    for (const [name, pid] of Object.entries(entry.pids)) {
      if (!isProcessAlive(pid)) continue;
      console.log(`  ${name} (PID ${pid})`);
      await stopProcessGroup(pid);
    }
    await stopCallbacksForVictim(input.callbackServers, entry.worktree);
  }
  writeDevServers(input.mainWorktree, input.registryDir, { servers: [] });
  console.log(`Stopped ${data.servers.length} dev-server(s).`);
}

export interface EvictInput {
  mainWorktree: string;
  registryDir: string;
  count: number;
  callbackServers: CallbackServer[];
  isAlive?: IsAliveFn;
  stop?: (pid: number) => Promise<void>;
}

export async function evictOldest(input: EvictInput): Promise<DevServerEntry[]> {
  const isAlive = input.isAlive ?? isProcessAlive;
  const stop = input.stop ?? stopProcessGroup;
  const data = pruneDeadServers(readDevServers(input.mainWorktree, input.registryDir), isAlive);
  const sorted = [...data.servers].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const victims = sorted.slice(0, input.count);
  for (const entry of victims) {
    for (const pid of Object.values(entry.pids)) {
      if (isAlive(pid)) await stop(pid);
    }
    await stopCallbacksForVictim(input.callbackServers, entry.worktree);
  }
  const victimSlots = new Set(victims.map((v) => v.slot));
  const filtered = data.servers.filter((entry) => !victimSlots.has(entry.slot));
  writeDevServers(input.mainWorktree, input.registryDir, { servers: filtered });
  return victims;
}

async function stopCallbacksForVictim(
  callbackServers: CallbackServer[],
  worktree: string,
): Promise<void> {
  for (const server of [...callbackServers].reverse()) {
    try {
      await server.stop({ cwd: worktree });
    } catch (err) {
      console.error(`  Failed to stop ${server.name} (${worktree}): ${(err as Error).message}`);
    }
  }
}

export function registerDevServer(
  mainWorktree: string,
  registryDir: string,
  entry: DevServerEntry,
): void {
  const data = pruneAndPersist(mainWorktree, registryDir);
  data.servers.push(entry);
  writeDevServers(mainWorktree, registryDir, data);
}

export function unregisterDevServer(
  mainWorktree: string,
  registryDir: string,
  worktreePath: string,
): void {
  const fp = filePath(mainWorktree, registryDir);
  if (!existsSync(fp)) return;
  const data = pruneAndPersist(mainWorktree, registryDir);
  const target = resolve(worktreePath);
  const filtered = data.servers.filter((entry) => resolve(entry.worktree) !== target);
  if (filtered.length === data.servers.length) return;
  writeDevServers(mainWorktree, registryDir, { servers: filtered });
}

export function removeDevServerEntryByWorktree(
  mainWorktree: string,
  registryDir: string,
  worktreePath: string,
): void {
  const fp = filePath(mainWorktree, registryDir);
  if (!existsSync(fp)) return;
  const data = readDevServers(mainWorktree, registryDir);
  const target = resolve(worktreePath);
  const filtered = data.servers.filter((entry) => resolve(entry.worktree) !== target);
  if (filtered.length === data.servers.length) return;
  writeDevServers(mainWorktree, registryDir, { servers: filtered });
}

/** Returns the entry whose worktree matches `worktreePath`, or `undefined`. Does not prune. */
export function findOwnEntry(
  mainWorktree: string,
  registryDir: string,
  worktreePath: string,
): DevServerEntry | undefined {
  const data = readDevServers(mainWorktree, registryDir);
  const target = resolve(worktreePath);
  return data.servers.find((entry) => resolve(entry.worktree) === target);
}

export function pruneAndPersist(
  mainWorktree: string,
  registryDir: string,
  isAlive: IsAliveFn = isProcessAlive,
): DevServersData {
  const data = readDevServers(mainWorktree, registryDir);
  const pruned = pruneDeadServers(data, isAlive);
  if (pruned.servers.length !== data.servers.length) {
    writeDevServers(mainWorktree, registryDir, pruned);
  }
  return pruned;
}

export function pruneDeadServers(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): DevServersData {
  const live = data.servers.filter((entry) =>
    Object.values(entry.pids).some((pid) => isAlive(pid)),
  );
  return { servers: live };
}

export function readDevServers(mainWorktree: string, registryDir: string): DevServersData {
  const fp = filePath(mainWorktree, registryDir);
  if (!existsSync(fp)) return { servers: [] };
  return JSON.parse(readFileSync(fp, "utf-8")) as DevServersData;
}

export function writeDevServers(
  mainWorktree: string,
  registryDir: string,
  data: DevServersData,
): void {
  const fp = filePath(mainWorktree, registryDir);
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(fp, `${JSON.stringify(data, undefined, 2)}\n`);
}

function filePath(mainWorktree: string, registryDir: string): string {
  return join(mainWorktree, registryDir, DEV_SERVERS_FILENAME);
}

function formatEntry(entry: DevServerEntry): string {
  const pids = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(",");
  const ownerPart = entry.owner ? `  owner=${entry.owner}` : "";
  return `  slot ${entry.slot}  branch=${entry.branch}${ownerPart}  pids=${pids}  startedAt=${entry.startedAt}  worktree=${entry.worktree}`;
}
