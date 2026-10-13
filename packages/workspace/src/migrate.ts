import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
  const old = JSON.parse(readFileSync(slotsPath, "utf-8")) as OldSlotsRegistry;
  const registry = convertSlotsRegistry({ old, mainWorktree: ctx.mainWorktree });
  await withRegistryLock(ctx.mainWorktree, input.registryDir, () =>
    writeWorkspaces(ctx.mainWorktree, input.registryDir, registry),
  );
  const translatedDevServers = translateDevServers(ctx.mainWorktree, input.registryDir);
  rmSync(slotsPath);
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
  if (mainEntry) workspaces[basename(mainWorktree)] = mainEntry;
  for (const entry of newestLinkedEntries(old, mainWorktree)) {
    const name = basename(entry.worktree);
    refuseDuplicateName(name, workspaces[name], entry.worktree);
    workspaces[name] = migratedEntry(entry);
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
  const entry = migratedEntry(newest);
  entry.worktree = mainWorktree;
  entry.main = true;
  return entry;
}

function isMainSlot(entry: OldSlotEntry, mainWorktree: string): boolean {
  return entry.main === true || resolve(entry.worktree) === resolve(mainWorktree);
}

/**
 * Linked entries, one per worktree path. A worktree registered again after a port-scheme change
 * leaves a same-path duplicate under another slot; the newest entry wins.
 */
function newestLinkedEntries(old: OldSlotsRegistry, mainWorktree: string): OldSlotEntry[] {
  const byPath = new Map<string, OldSlotEntry>();
  for (const entry of Object.values(old.slots)) {
    if (isMainSlot(entry, mainWorktree)) continue;
    const kept = byPath.get(resolve(entry.worktree));
    if (!kept || entry.createdAt > kept.createdAt) byPath.set(resolve(entry.worktree), entry);
  }
  return [...byPath.values()];
}

function refuseDuplicateName(
  name: string,
  existing: WorkspaceEntry | undefined,
  worktree: string,
): void {
  if (!existing) return;
  throw new WorkspaceError(
    `Two worktrees share the directory name "${name}": ${existing.worktree} and ${worktree}. ` +
      "Worktree directory names must be unique. Remove one of the worktrees, delete its entry " +
      `from slots.json, then re-run \`${wsCmd("migrate-registry-0.30")}\`.`,
  );
}

function migratedEntry(old: OldSlotEntry): WorkspaceEntry {
  const entry: WorkspaceEntry = {
    worktree: old.worktree,
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
function translateDevServers(mainWorktree: string, registryDir: string): number {
  const filePath = devServersFilePath(mainWorktree, registryDir);
  if (!existsSync(filePath)) return 0;
  const data = JSON.parse(readFileSync(filePath, "utf-8")) as { servers: OldDevServerEntry[] };
  const servers = data.servers.map((old): DevServerEntry => {
    const entry: DevServerEntry = {
      name: old.name ?? basename(old.worktree),
      worktree: old.worktree,
      pids: old.pids,
      startedAt: old.startedAt,
    };
    if (old.main === true) entry.main = true;
    return entry;
  });
  writeDevServers(mainWorktree, registryDir, { servers });
  return servers.length;
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
