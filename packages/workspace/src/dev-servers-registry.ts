import { resolve } from "node:path";

import { consoleWorkspaceOutput, type WorkspaceOutput } from "./operation.js";
import { errorMessage, WorkspaceError } from "./errors.js";
import { isProcessAlive } from "./process-control.js";
import { withRegistryLock } from "./registry-lock.js";
import { claimRegistryStorage, readRegistry, writeRegistry } from "./registry-storage.js";
import { readWorkspaces } from "./workspaces.js";
import { assertStartupOwner, type StartupOwner } from "./startup-ownership.js";
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
          instanceId: { type: "string", minLength: 1 },
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
  instanceId?: string;
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
  stopTarget: (entry: DevServerEntry) => Promise<void>;
  output?: WorkspaceOutput;
}

export async function stopAllRegistered(input: StopAllInput): Promise<void> {
  const output = input.output ?? consoleWorkspaceOutput();
  const data = await pruneAndPersist(input.mainWorktree, input.registryDir);
  if (data.servers.length === 0) {
    output.text("No dev-servers running.");
    return;
  }
  const failures: unknown[] = [];
  for (const entry of data.servers) {
    const branch = getWorktreeBranch(entry.worktree) ?? "(detached)";
    output.text(`Stopping workspace ${entry.name} (${branch})...`);
    try {
      await input.stopTarget(entry);
      await completeDevServerCleanup(
        input.mainWorktree,
        input.registryDir,
        entry.worktree,
        entry.startedAt,
        entry.instanceId,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map(errorMessage).join("; "));
  output.text(`Stopped ${data.servers.length} dev-server(s).`);
}

export interface EvictInput {
  mainWorktree: string;
  registryDir: string;
  count: number;
  stopTarget: (entry: DevServerEntry) => Promise<void>;
  output?: WorkspaceOutput;
  isAlive?: IsAliveFn;
}

export async function evictOldest(input: EvictInput): Promise<DevServerEntry[]> {
  const isAlive = input.isAlive ?? isProcessAlive;
  const data = readDevServers(input.mainWorktree, input.registryDir);
  const sorted = liveDevServers(data, isAlive).sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const victims = sorted.slice(0, input.count);
  for (const entry of victims) {
    await input.stopTarget(entry);
    await completeDevServerCleanup(
      input.mainWorktree,
      input.registryDir,
      entry.worktree,
      entry.startedAt,
      entry.instanceId,
    );
  }
  return victims;
}

export async function registerDevServer(
  mainWorktree: string,
  registryDir: string,
  entry: DevServerEntry,
  owner?: StartupOwner,
): Promise<void> {
  await updateDevServers(mainWorktree, registryDir, (data) => {
    if (owner) assertStartupOwner(mainWorktree, registryDir, owner);
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
  owner?: StartupOwner,
): Promise<DevServerEntry | undefined> {
  return updateDevServers(mainWorktree, registryDir, (data) => {
    if (owner) assertStartupOwner(mainWorktree, registryDir, owner);
    let entry = data.servers.find((server) => resolve(server.worktree) === resolve(worktree));
    if (entry && rollback && entry.instanceId !== rollback.instanceId) return;
    if (entry && rollback && entry.startedAt !== rollback.startedAt) return;
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
  instanceId?: string,
): Promise<void> {
  await updateDevServers(mainWorktree, registryDir, (data) => {
    data.servers = data.servers.filter(
      (entry) =>
        resolve(entry.worktree) !== resolve(worktree) ||
        (startedAt !== undefined && entry.startedAt !== startedAt) ||
        (instanceId !== undefined && entry.instanceId !== instanceId),
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
  readWorkspaces(mainWorktree, registryDir);
  const path = devServersFilePath(mainWorktree, registryDir);
  const data = readRegistry<DevServersData>(path, REGISTRY_SCHEMA, { servers: [] }, mainWorktree);
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
  claimRegistryStorage(mainWorktree, resolve(mainWorktree, registryDir));
  writeRegistry(
    devServersFilePath(mainWorktree, registryDir),
    { version: 1, servers: data.servers },
    REGISTRY_SCHEMA,
    mainWorktree,
  );
}

export function devServersFilePath(mainWorktree: string, registryDir: string): string {
  return resolve(mainWorktree, registryDir, DEV_SERVERS_FILENAME);
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
