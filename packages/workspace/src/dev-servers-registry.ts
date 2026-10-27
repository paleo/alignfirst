import { join, resolve } from "node:path";

import { consoleWorkspaceOutput, type WorkspaceOutput } from "./operation.js";
import { WorkspaceError } from "./errors.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import { withRegistryLock } from "./registry-lock.js";
import { readRegistry, writeRegistry } from "./registry-storage.js";
import type { CallbackServer, ServerContext } from "./server-descriptor.js";
import { getWorktreeBranch } from "./worktree.js";

const DEV_SERVERS_FILENAME = "dev-servers.json";
const REGISTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "servers"],
  properties: {
    version: { const: 1 },
    servers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "worktree", "pids", "startedAt"],
        properties: {
          name: { type: "string", minLength: 1 },
          worktree: { type: "string", pattern: "^/" },
          pids: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
          startedAt: { type: "string", format: "date-time" },
          main: { type: "boolean" },
          cleanupPending: { const: true },
        },
      },
    },
  },
};

export interface DevServerEntry {
  name: string;
  worktree: string;
  pids: Record<string, number>;
  startedAt: string;
  main?: boolean;
  cleanupPending?: true;
}

export interface DevServersData {
  servers: DevServerEntry[];
}

export type IsAliveFn = (pid: number) => boolean;
export type PortsLookup = (worktree: string) => Record<string, number>;

export async function listDevServers(
  mainWorktree: string,
  registryDir: string,
  output: WorkspaceOutput = consoleWorkspaceOutput(),
): Promise<void> {
  const data = await pruneAndPersist(mainWorktree, registryDir);
  if (data.servers.length === 0) {
    output.text("No dev-servers running.");
    return;
  }
  for (const entry of sortByName(data.servers)) output.text(formatEntry(entry));
}

export function printActiveServers(
  active: DevServerEntry[],
  output: WorkspaceOutput = consoleWorkspaceOutput(),
): void {
  for (const entry of sortByName(active)) output.diagnostic(formatEntry(entry));
}

export interface StopAllInput {
  mainWorktree: string;
  registryDir: string;
  callbackServers: CallbackServer[];
  portsOf: PortsLookup;
  output?: WorkspaceOutput;
}

export async function stopAllRegistered(input: StopAllInput): Promise<void> {
  const output = input.output ?? consoleWorkspaceOutput();
  const data = await pruneAndPersist(input.mainWorktree, input.registryDir);
  if (data.servers.length === 0) {
    output.text("No dev-servers running.");
    return;
  }
  for (const entry of data.servers) {
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    output.text(`Stopping workspace ${entry.name} (${branch})...`);
    for (const [name, pid] of Object.entries(entry.pids)) {
      if (!isProcessAlive(pid)) continue;
      output.text(`  ${name} (PID ${pid})`);
      await stopProcessGroup(pid);
    }
    await stopCallbacksForVictim(
      input.callbackServers,
      victimContext(entry, input.portsOf),
      output,
    );
    await completeDevServerCleanup(
      input.mainWorktree,
      input.registryDir,
      entry.worktree,
      entry.startedAt,
    );
  }
  output.text(`Stopped ${data.servers.length} dev-server(s).`);
}

export interface EvictInput {
  mainWorktree: string;
  registryDir: string;
  count: number;
  callbackServers: CallbackServer[];
  portsOf: PortsLookup;
  output?: WorkspaceOutput;
  isAlive?: IsAliveFn;
  stop?: (pid: number) => Promise<void>;
}

export async function evictOldest(input: EvictInput): Promise<DevServerEntry[]> {
  const isAlive = input.isAlive ?? isProcessAlive;
  const stop = input.stop ?? stopProcessGroup;
  const data = readDevServers(input.mainWorktree, input.registryDir);
  const sorted = liveDevServers(data, isAlive).sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const victims = sorted.slice(0, input.count);
  for (const entry of victims) {
    for (const pid of Object.values(entry.pids)) {
      if (isAlive(pid)) await stop(pid);
    }
    await stopCallbacksForVictim(
      input.callbackServers,
      victimContext(entry, input.portsOf),
      input.output ?? consoleWorkspaceOutput(),
    );
    await completeDevServerCleanup(
      input.mainWorktree,
      input.registryDir,
      entry.worktree,
      entry.startedAt,
    );
  }
  return victims;
}

function victimContext(entry: DevServerEntry, portsOf: PortsLookup): ServerContext {
  return { name: entry.name, cwd: entry.worktree, ports: portsOf(entry.worktree) };
}

async function stopCallbacksForVictim(
  callbackServers: CallbackServer[],
  ctx: ServerContext,
  output: WorkspaceOutput,
): Promise<void> {
  for (const server of [...callbackServers].reverse()) {
    output.text(`  ${server.name} (callback)`);
    await server.stop(ctx);
  }
}

export async function registerDevServer(
  mainWorktree: string,
  registryDir: string,
  entry: DevServerEntry,
): Promise<void> {
  await updateDevServers(mainWorktree, registryDir, (data) => {
    const existing = data.servers.find(
      (server) => resolve(server.worktree) === resolve(entry.worktree),
    );
    if (existing?.cleanupPending === true) throw cleanupPendingError(entry.worktree);
    if (existing && hasLiveSpawnPids(existing))
      throw new WorkspaceError(`Dev-server already registered at ${entry.worktree}.`);
    data.servers = pruneDeadServers(data).servers;
    data.servers.push({ ...entry, worktree: resolve(entry.worktree) });
  });
}

/** Fresh, unpruned state closes the dead-PID window before an asynchronous stop or rollback. */
export async function markDevServerCleanupPending(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  rollback?: DevServerEntry,
): Promise<DevServerEntry | undefined> {
  return updateDevServers(mainWorktree, registryDir, (data) => {
    let entry = data.servers.find((server) => resolve(server.worktree) === resolve(worktree));
    if (!entry && rollback) {
      if (resolve(rollback.worktree) !== resolve(worktree))
        throw new WorkspaceError("Rollback identity does not match cleanup path.");
      entry = { ...rollback, worktree: resolve(worktree) };
      data.servers.push(entry);
    }
    if (entry) entry.cleanupPending = true;
    return entry;
  });
}

/** The caller confirms all cleanup succeeded. Never replaces a captured whole-registry snapshot. */
export async function completeDevServerCleanup(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  startedAt?: string,
): Promise<void> {
  await updateDevServers(mainWorktree, registryDir, (data) => {
    data.servers = data.servers.filter(
      (entry) =>
        resolve(entry.worktree) !== resolve(worktree) ||
        (startedAt !== undefined && entry.startedAt !== startedAt),
    );
  });
}

export function assertNoPendingCleanup(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): void {
  if (findOwnEntry(mainWorktree, registryDir, worktree)?.cleanupPending === true)
    throw cleanupPendingError(worktree);
}

function cleanupPendingError(worktree: string): WorkspaceError {
  return new WorkspaceError(
    `Cleanup is pending for ${worktree}. Retry alignfirst dev down before starting again.`,
  );
}

/** Exact path lookup deliberately does not prune retained cleanup records. */
export function findOwnEntry(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): DevServerEntry | undefined {
  return readDevServers(mainWorktree, registryDir).servers.find(
    (entry) => resolve(entry.worktree) === resolve(worktree),
  );
}

export async function pruneAndPersist(
  mainWorktree: string,
  registryDir: string,
  isAlive: IsAliveFn = isProcessAlive,
): Promise<DevServersData> {
  return updateDevServers(mainWorktree, registryDir, (data) => {
    data.servers = pruneDeadServers(data, isAlive).servers;
    return data;
  });
}

export function pruneDeadServers(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): DevServersData {
  return {
    servers: data.servers.filter(
      (entry) => entry.cleanupPending === true || hasLiveSpawnPids(entry, isAlive),
    ),
  };
}

export function hasLiveSpawnPids(
  entry: DevServerEntry,
  isAlive: IsAliveFn = isProcessAlive,
): boolean {
  return Object.values(entry.pids).some(isAlive);
}

export function liveDevServers(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): DevServerEntry[] {
  return data.servers.filter((entry) => hasLiveSpawnPids(entry, isAlive));
}

export function liveWorktrees(
  data: DevServersData,
  isAlive: IsAliveFn = isProcessAlive,
): Set<string> {
  return new Set(liveDevServers(data, isAlive).map((entry) => resolve(entry.worktree)));
}

export async function updateDevServers<T>(
  mainWorktree: string,
  registryDir: string,
  mutate: (data: DevServersData) => T,
): Promise<T> {
  return withRegistryLock(mainWorktree, registryDir, () => {
    const data = readDevServers(mainWorktree, registryDir);
    const result = mutate(data);
    writeDevServers(mainWorktree, registryDir, data);
    return result;
  });
}

export function readDevServers(mainWorktree: string, registryDir: string): DevServersData {
  const path = devServersFilePath(mainWorktree, registryDir);
  const data = readRegistry<DevServersData>(path, REGISTRY_SCHEMA, { servers: [] });
  const paths = data.servers.map((entry) => resolve(entry.worktree));
  if (new Set(paths).size !== paths.length)
    throw new WorkspaceError(`Invalid registry ${path}: duplicate worktree identities.`);
  return { servers: data.servers };
}

/** Low-level atomic persistence; production mutations use updateDevServers. */
export function writeDevServers(
  mainWorktree: string,
  registryDir: string,
  data: DevServersData,
): void {
  readDevServers(mainWorktree, registryDir);
  writeRegistry(
    devServersFilePath(mainWorktree, registryDir),
    { version: 1, servers: data.servers },
    REGISTRY_SCHEMA,
  );
}

export function devServersFilePath(mainWorktree: string, registryDir: string): string {
  return join(mainWorktree, registryDir, DEV_SERVERS_FILENAME);
}

function sortByName(servers: DevServerEntry[]): DevServerEntry[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name));
}

function formatEntry(entry: DevServerEntry): string {
  const pids = Object.entries(entry.pids)
    .map(([name, pid]) => `${name}=${pid}`)
    .join(",");
  const type = entry.main ? "main" : "linked";
  const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
  const cleanup = entry.cleanupPending === true ? "  cleanupPending=true" : "";
  return `  ${entry.name}  type=${type}  branch=${branch}  pids=${pids}  startedAt=${entry.startedAt}  worktree=${entry.worktree}${cleanup}`;
}
