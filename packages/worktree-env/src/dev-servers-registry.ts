import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isProcessAlive, stopProcessGroup } from "./process-control.js";

export const DEV_SERVERS_FILE = ".local/worktrees/dev-servers.json";
export const WORKTREES_DIR = ".local/worktrees";

export interface DevServerEntry {
  slot: number;
  worktree: string;
  branch: string;
  owner: string;
  pids: Record<string, number>;
  startedAt: string;
}

export interface DevServersData {
  servers: DevServerEntry[];
}

function filePath(mainWorktree: string): string {
  return join(mainWorktree, DEV_SERVERS_FILE);
}

export function readDevServers(mainWorktree: string): DevServersData {
  const fp = filePath(mainWorktree);
  if (!existsSync(fp)) return { servers: [] };
  return JSON.parse(readFileSync(fp, "utf-8")) as DevServersData;
}

export function writeDevServers(mainWorktree: string, data: DevServersData): void {
  const fp = filePath(mainWorktree);
  mkdirSync(join(mainWorktree, WORKTREES_DIR), { recursive: true });
  writeFileSync(fp, `${JSON.stringify(data, undefined, 2)}\n`);
}

export type IsAliveFn = (pid: number) => boolean;

export function pruneDeadServers(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): DevServersData {
  const live = data.servers.filter((entry) =>
    Object.values(entry.pids).some((pid) => isAlive(pid)),
  );
  return { servers: live };
}

export function pruneAndPersist(
  mainWorktree: string,
  isAlive: IsAliveFn = isProcessAlive,
): DevServersData {
  const data = readDevServers(mainWorktree);
  const pruned = pruneDeadServers(data, isAlive);
  if (pruned.servers.length !== data.servers.length) {
    writeDevServers(mainWorktree, pruned);
  }
  return pruned;
}

export function registerDevServer(mainWorktree: string, entry: DevServerEntry): void {
  const data = pruneAndPersist(mainWorktree);
  data.servers.push(entry);
  writeDevServers(mainWorktree, data);
}

export function unregisterDevServer(mainWorktree: string, worktreePath: string): void {
  const fp = filePath(mainWorktree);
  if (!existsSync(fp)) return;
  const data = pruneAndPersist(mainWorktree);
  const target = resolve(worktreePath);
  const filtered = data.servers.filter((entry) => resolve(entry.worktree) !== target);
  if (filtered.length === data.servers.length) return;
  writeDevServers(mainWorktree, { servers: filtered });
}

export function removeDevServerEntryByWorktree(mainWorktree: string, worktreePath: string): void {
  const fp = filePath(mainWorktree);
  if (!existsSync(fp)) return;
  const data = readDevServers(mainWorktree);
  const target = resolve(worktreePath);
  const filtered = data.servers.filter((entry) => resolve(entry.worktree) !== target);
  if (filtered.length === data.servers.length) return;
  writeDevServers(mainWorktree, { servers: filtered });
}

function formatEntry(entry: DevServerEntry): string {
  const pids = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(",");
  return `  slot ${entry.slot}  branch=${entry.branch}  owner=${entry.owner}  pids=${pids}  startedAt=${entry.startedAt}  worktree=${entry.worktree}`;
}

export function printActiveServers(active: DevServerEntry[]): void {
  const sorted = [...active].sort((a, b) => a.slot - b.slot);
  for (const entry of sorted) {
    process.stderr.write(`${formatEntry(entry)}\n`);
  }
}

export function listDevServers(mainWorktree: string): void {
  const data = pruneAndPersist(mainWorktree);
  if (data.servers.length === 0) {
    console.log("No dev-servers running.");
    return;
  }
  const sorted = [...data.servers].sort((a, b) => a.slot - b.slot);
  for (const entry of sorted) {
    console.log(formatEntry(entry));
  }
}

export interface StopAllInput {
  mainWorktree: string;
  pidFiles: string[];
}

export async function stopAllRegistered(input: StopAllInput): Promise<void> {
  const data = pruneAndPersist(input.mainWorktree);
  if (data.servers.length === 0) {
    console.log("No dev-servers running.");
    return;
  }
  for (const entry of data.servers) {
    console.log(`Stopping slot ${entry.slot} (${entry.branch}, owner=${entry.owner})...`);
    for (const [name, pid] of Object.entries(entry.pids)) {
      if (!isProcessAlive(pid)) continue;
      console.log(`  ${name} (PID ${pid})`);
      await stopProcessGroup(pid);
    }
    for (const pidFile of input.pidFiles) {
      const fp = join(entry.worktree, pidFile);
      if (existsSync(fp)) unlinkSync(fp);
    }
  }
  writeDevServers(input.mainWorktree, { servers: [] });
  console.log(`Stopped ${data.servers.length} dev-server(s).`);
}
