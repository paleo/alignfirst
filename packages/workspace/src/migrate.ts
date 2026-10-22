import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type DevServerEntry,
  devServersFilePath,
  writeDevServers,
} from "./dev-servers-registry.js";
import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";
import { withRegistryLock } from "./registry-lock.js";
import { getWorktreeBranch, type WorktreeContext } from "./worktree.js";
import {
  allocateWorkspaceName,
  findWorkspaceByPath,
  type WorkspaceEntry,
  type WorkspacesRegistry,
  workspacesFilePath,
  type WorkspaceStatus,
  writeWorkspaces,
} from "./workspaces.js";

const SLOTS_FILENAME = "slots.json";

/** The pre-`workspaces.json` registry: one entry per slot, keyed by the slot's port. */
export interface OldSlotsRegistry {
  slots: Record<string, OldSlotEntry>;
}

export interface OldSlotEntry {
  worktree: string;
  createdAt: string;
  status: WorkspaceStatus;
  failure?: { at: string; message: string };
  main?: boolean;
  extra?: unknown;
}

export interface MigrateInput {
  registryDir: string;
  /** Gates the slot-named-infrastructure warning: a consumer tearing down by name is the one
   * whose resource names were derived from the slot. */
  hasPurgeInfrastructure: boolean;
}

export async function runMigrate(ctx: WorktreeContext, input: MigrateInput): Promise<void> {
  if (!ctx.isMainWorktree) {
    throw new WorkspaceError(
      `\`workspace migrate-registry-0.30\` must run from the main worktree: ${ctx.mainWorktree}`,
    );
  }
  const slotsPath = join(ctx.mainWorktree, input.registryDir, SLOTS_FILENAME);
  if (!existsSync(slotsPath)) {
    console.log("No old registry (slots.json) found. Nothing to migrate.");
    return;
  }
  if (existsSync(workspacesFilePath(ctx.mainWorktree, input.registryDir))) {
    throw new WorkspaceError(
      `The registry is already migrated, yet ${slotsPath} exists — typically re-created by a ` +
        "workspace command run on a branch that still uses the old package. Delete the file, " +
        "and update that branch (merge the base branch, then reinstall dependencies).",
    );
  }
  const { registry, translatedDevServers } = await withRegistryLock(
    ctx.mainWorktree,
    input.registryDir,
    () => {
      if (existsSync(workspacesFilePath(ctx.mainWorktree, input.registryDir))) {
        throw new WorkspaceError("The registry is already migrated. No files were changed.");
      }
      const old = JSON.parse(readFileSync(slotsPath, "utf-8")) as OldSlotsRegistry;
      const registry = convertSlotsRegistry({ old, mainWorktree: ctx.mainWorktree });
      const translatedDevServers = translateDevServers(
        ctx.mainWorktree,
        input.registryDir,
        old,
        registry,
      );
      writeWorkspaces(ctx.mainWorktree, input.registryDir, registry);
      rmSync(slotsPath);
      return { registry, translatedDevServers };
    },
  );
  printMigrationReport(registry, translatedDevServers, input.hasPurgeInfrastructure);
}

export interface ConvertInput {
  old: OldSlotsRegistry;
  mainWorktree: string;
}

/** Migrated entries carry no ports: they get them at their next `dev setup`. */
export function convertSlotsRegistry({ old, mainWorktree }: ConvertInput): WorkspacesRegistry {
  const workspaces: Record<string, WorkspaceEntry> = {};
  const mainEntry = collapseMainEntries(old, mainWorktree);
  if (mainEntry) workspaces[allocateWorkspaceName(workspaces, mainWorktree)] = mainEntry;
  for (const entry of newestLinkedEntries(old, mainWorktree)) {
    const name = allocateWorkspaceName(workspaces, resolve(mainWorktree, entry.worktree));
    workspaces[name] = migratedEntry(entry, mainWorktree);
  }
  return { workspaces };
}

/**
 * All entries describing the main worktree collapse into one, keyed by the real main worktree —
 * old registries accumulate stale main entries when `basePort` changes, and their recorded paths
 * go stale when the repository moves on disk. The newest entry's fields win.
 */
function collapseMainEntries(
  old: OldSlotsRegistry,
  mainWorktree: string,
): WorkspaceEntry | undefined {
  const mains = Object.values(old.slots).filter((entry) => isMainSlot(entry, mainWorktree));
  if (mains.length === 0) return;
  const newest = mains.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  const entry = migratedEntry(newest, mainWorktree);
  entry.worktree = resolve(mainWorktree);
  entry.main = true;
  return entry;
}

function isMainSlot(entry: OldSlotEntry, mainWorktree: string): boolean {
  return entry.main === true || resolve(mainWorktree, entry.worktree) === resolve(mainWorktree);
}

/**
 * Linked entries, one per worktree path. A worktree registered again after a port-scheme change
 * leaves a same-path duplicate under another slot; the newest entry wins.
 */
function newestLinkedEntries(old: OldSlotsRegistry, mainWorktree: string): OldSlotEntry[] {
  const byPath = new Map<string, OldSlotEntry>();
  for (const entry of Object.values(old.slots)) {
    if (isMainSlot(entry, mainWorktree)) continue;
    const path = resolve(mainWorktree, entry.worktree);
    const kept = byPath.get(path);
    if (!kept || entry.createdAt > kept.createdAt) byPath.set(path, entry);
  }
  return [...byPath.values()];
}

function migratedEntry(old: OldSlotEntry, mainWorktree: string): WorkspaceEntry {
  const entry: WorkspaceEntry = {
    worktree: resolve(mainWorktree, old.worktree),
    createdAt: old.createdAt,
    status: old.status,
  };
  if (old.failure) entry.failure = old.failure;
  if (old.extra !== undefined) entry.purgeData = old.extra;
  // The old `finalizeWorkspace` of a ready entry already provisioned its infrastructure.
  if (old.status === "ready") entry.devSetupAt = old.createdAt;
  return entry;
}

interface OldDevServerEntry {
  slot?: number;
  name?: string;
  worktree: string;
  pids: Record<string, number>;
  startedAt: string;
  main?: boolean;
}

/** Rekeys `dev-servers.json` entries from `slot` to the workspace name. Running PIDs stay valid. */
function translateDevServers(
  mainWorktree: string,
  registryDir: string,
  slots: OldSlotsRegistry,
  registry: WorkspacesRegistry,
): number {
  const filePath = devServersFilePath(mainWorktree, registryDir);
  if (!existsSync(filePath)) return 0;
  const data = JSON.parse(readFileSync(filePath, "utf-8")) as { servers: OldDevServerEntry[] };
  const { paths, bySlot } = convertedIdentities(slots, registry, mainWorktree);
  const reserved: Record<string, { worktree: string }> = { ...registry.workspaces };
  const translated = data.servers.map((old): DevServerEntry => {
    const path = resolve(mainWorktree, old.worktree);
    const converted =
      paths.get(path) ?? (old.slot === undefined ? undefined : bySlot.get(String(old.slot)));
    const worktree = converted?.worktree ?? (old.main === true ? resolve(mainWorktree) : path);
    const name = converted?.name ?? reserveDevOnlyName(reserved, old.name, worktree);
    reserved[name] = { worktree };
    paths.set(path, { name, worktree, main: converted?.main ?? old.main });
    const entry: DevServerEntry = { name, worktree, pids: old.pids, startedAt: old.startedAt };
    if ((converted?.main ?? old.main) === true) entry.main = true;
    return entry;
  });
  const servers = consolidateDevServers(translated);
  writeDevServers(mainWorktree, registryDir, { servers });
  return servers.length;
}

function consolidateDevServers(entries: DevServerEntry[]): DevServerEntry[] {
  const byWorktree = new Map<string, DevServerEntry>();
  for (const entry of entries) {
    const kept = byWorktree.get(entry.worktree) ?? { ...entry, pids: {} };
    kept.pids = mergeDevServerPids(kept.pids, entry.pids);
    if (entry.startedAt < kept.startedAt) kept.startedAt = entry.startedAt;
    if (entry.main === true) kept.main = true;
    byWorktree.set(entry.worktree, kept);
  }
  return [...byWorktree.values()];
}

function mergeDevServerPids(
  kept: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  const pids = new Map(Object.entries(kept));
  const knownPids = new Set(pids.values());
  for (const [label, pid] of Object.entries(incoming)) {
    if (knownPids.has(pid)) continue;
    let name = label;
    let suffix = 1;
    while (pids.has(name)) name = `${label}-${++suffix}`;
    pids.set(name, pid);
    knownPids.add(pid);
  }
  return Object.fromEntries(pids);
}

interface ConvertedIdentities {
  paths: Map<string, DevIdentity>;
  bySlot: Map<string, DevIdentity>;
}

interface DevIdentity {
  name: string;
  worktree: string;
  main?: boolean;
}

function convertedIdentities(
  slots: OldSlotsRegistry,
  registry: WorkspacesRegistry,
  mainWorktree: string,
): ConvertedIdentities {
  const paths = new Map<string, DevIdentity>();
  const bySlot = new Map<string, DevIdentity>();
  for (const [slot, old] of Object.entries(slots.slots)) {
    const path = resolve(mainWorktree, old.worktree);
    const target = isMainSlot(old, mainWorktree) ? mainWorktree : path;
    const found = findWorkspaceByPath(registry, target);
    if (!found) continue;
    const identity = { name: found.name, worktree: found.entry.worktree, main: found.entry.main };
    paths.set(path, identity);
    bySlot.set(slot, identity);
  }
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    paths.set(entry.worktree, { name, worktree: entry.worktree, main: entry.main });
  }
  return { paths, bySlot };
}

function reserveDevOnlyName(
  reserved: Record<string, { worktree: string }>,
  recordedName: string | undefined,
  worktree: string,
): string {
  const existing = Object.entries(reserved).find(([, entry]) => entry.worktree === worktree);
  if (existing) return existing[0];
  if (recordedName !== undefined && !Object.hasOwn(reserved, recordedName)) return recordedName;
  return allocateWorkspaceName(reserved, worktree);
}

function printMigrationReport(
  registry: WorkspacesRegistry,
  translatedDevServers: number,
  hasPurgeInfrastructure: boolean,
): void {
  const entries = Object.entries(registry.workspaces);
  console.log(`Migrated ${entries.length} workspace(s) to workspaces.json:`);
  for (const [name, entry] of entries) {
    console.log(`  ${name}${entry.main ? " (main)" : ""}  ${entry.worktree}`);
  }
  if (translatedDevServers > 0) {
    console.log(`Translated ${translatedDevServers} dev-server entry(ies).`);
  }
  console.log("Deleted slots.json.");
  const linked = entries.filter(([, entry]) => entry.main !== true);
  printInfrastructureWarning(hasPurgeInfrastructure, linked.length);
  printBranchesToUpdate(linked);
}

function printInfrastructureWarning(hasPurgeInfrastructure: boolean, linkedCount: number): void {
  if (!hasPurgeInfrastructure || linkedCount === 0) return;
  console.log(
    "\nWarning: infrastructure names (containers, volumes) previously derived from the slot can " +
      "no longer be derived. Remove the old-named resources manually, or they will leak. Nothing " +
      "else needs a rerun: each workspace gets its ports and run files at its next dev start.",
  );
}

function printBranchesToUpdate(linked: [string, WorkspaceEntry][]): void {
  const existing = linked.filter(([, entry]) => existsSync(entry.worktree));
  if (existing.length > 0) {
    console.log(
      "\nBranches to update (in each worktree: merge the base branch, then reinstall dependencies):",
    );
    for (const [, entry] of existing) {
      console.log(`  ${getWorktreeBranch(entry.worktree) ?? "(detached)"}  ${entry.worktree}`);
    }
  }
  const orphans = linked.filter(([, entry]) => !existsSync(entry.worktree));
  if (orphans.length > 0) {
    console.log(
      `\nOrphaned entries kept (worktree directory missing): ${orphans
        .map(([name]) => name)
        .join(", ")}. Heal them with \`${wsCmd("prune")}\`.`,
    );
  }
}

/** Blocks every other command on a pre-migration registry, so it never reads as "no workspaces". */
export function refuseOldRegistry(mainWorktree: string, registryDir: string): void {
  const slotsPath = join(mainWorktree, registryDir, SLOTS_FILENAME);
  if (!existsSync(slotsPath)) return;
  console.error(
    `Error: Old registry found at ${slotsPath}. Run \`${wsCmd("migrate-registry-0.30")}\` from the main worktree.`,
  );
  process.exit(1);
}
