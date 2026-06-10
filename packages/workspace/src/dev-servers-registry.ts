import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import type { CallbackServer } from "./server-descriptor.js";
import { getWorktreeBranch } from "./worktree.js";

const DEV_SERVERS_FILENAME = "dev-servers.json";

export interface DevServerEntry {
  slot: number;
  worktree: string;
  owner?: string;
  pids: Record<string, number>;
  startedAt: string;
  /** `true` for the main-worktree entry. */
  main?: boolean;
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
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    console.log(`Stopping slot ${entry.slot} (${branch}${ownerSuffix})...`);
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
    console.log(`  ${server.name} (callback)`);
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

/** Resolved worktree paths whose dev-server entry has at least one live PID. */
export function liveWorktrees(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): Set<string> {
  const live = new Set<string>();
  for (const entry of data.servers) {
    if (Object.values(entry.pids).some((pid) => isAlive(pid))) {
      live.add(resolve(entry.worktree));
    }
  }
  return live;
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

/** Union by resolved `worktree`; `override` wins on conflict. Base-first then override-only order. */
export function mergeDevServers(base: DevServersData, override: DevServersData): DevServersData {
  const overrideByWorktree = new Map(override.servers.map((e) => [resolve(e.worktree), e]));
  const merged: DevServerEntry[] = base.servers.map(
    (entry) => overrideByWorktree.get(resolve(entry.worktree)) ?? entry,
  );
  const baseWorktrees = new Set(base.servers.map((e) => resolve(e.worktree)));
  for (const entry of override.servers) {
    if (!baseWorktrees.has(resolve(entry.worktree))) merged.push(entry);
  }
  return { servers: merged };
}

function filePath(mainWorktree: string, registryDir: string): string {
  return join(mainWorktree, registryDir, DEV_SERVERS_FILENAME);
}

function formatEntry(entry: DevServerEntry): string {
  const pids = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(",");
  const ownerPart = entry.owner ? `  owner=${entry.owner}` : "";
  const type = entry.main ? "main" : "linked";
  const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
  return `  slot ${entry.slot}  type=${type}  branch=${branch}${ownerPart}  pids=${pids}  startedAt=${entry.startedAt}  worktree=${entry.worktree}`;
}
