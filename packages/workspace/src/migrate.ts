import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  type DevServerEntry,
  devServersFilePath,
  writeDevServers,
} from "./dev-servers-registry.js";
import { WorkspaceError } from "./errors.js";
import { wsCmd } from "./package-manager.js";
import type { ResolvedPortsConfig } from "./ports.js";
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
  /** Resolved port scheme. Omit in portless mode: entries carry no port index. */
  ports?: ResolvedPortsConfig;
  /** Gates the slot-named-infrastructure warning: a consumer tearing down by name is the one
   * whose resource names were derived from the slot. */
  hasPurgeInfrastructure: boolean;
}

export function runMigrate(ctx: WorktreeContext, input: MigrateInput): void {
  if (!ctx.isMainWorktree) {
    throw new WorkspaceError(
      `\`workspace migrate\` must run from the main worktree: ${ctx.mainWorktree}`,
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
  const conversion = convertSlotsRegistry({
    old,
    mainWorktree: ctx.mainWorktree,
    ports: input.ports,
  });
  writeWorkspaces(ctx.mainWorktree, input.registryDir, conversion.registry);
  const translatedDevServers = translateDevServers(ctx.mainWorktree, input.registryDir);
  rmSync(slotsPath);
  printMigrationReport(conversion, translatedDevServers, input.hasPurgeInfrastructure);
}

export interface ConvertInput {
  old: OldSlotsRegistry;
  mainWorktree: string;
  ports?: ResolvedPortsConfig;
}

export interface Conversion {
  registry: WorkspacesRegistry;
  /** Linked entries migrated without a port index: their slot does not fit the `ports` scheme. */
  stale: string[];
}

export function convertSlotsRegistry({ old, mainWorktree, ports }: ConvertInput): Conversion {
  const workspaces: Record<string, WorkspaceEntry> = {};
  const mainEntry = collapseMainEntries(old, mainWorktree);
  if (mainEntry) workspaces[basename(mainWorktree)] = mainEntry;
  const stale: string[] = [];
  for (const [slot, entry] of newestLinkedEntries(old, mainWorktree)) {
    const name = basename(entry.worktree);
    refuseDuplicateName(name, workspaces[name], entry.worktree);
    const migrated = migratedEntry(entry);
    if (ports) {
      const index = deriveIndex(Number(slot), ports);
      if (index === undefined) stale.push(name);
      else migrated.portIndex = index;
    }
    workspaces[name] = migrated;
  }
  return { registry: { workspaces }, stale };
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
 * Linked entries, one per worktree path with its slot key. A worktree registered again after a
 * port-scheme change leaves a same-path duplicate under another slot; the newest entry wins.
 */
function newestLinkedEntries(
  old: OldSlotsRegistry,
  mainWorktree: string,
): [string, OldSlotEntry][] {
  const byPath = new Map<string, [string, OldSlotEntry]>();
  for (const [slot, entry] of Object.entries(old.slots)) {
    if (isMainSlot(entry, mainWorktree)) continue;
    const kept = byPath.get(resolve(entry.worktree));
    if (!kept || entry.createdAt > kept[1].createdAt) {
      byPath.set(resolve(entry.worktree), [slot, entry]);
    }
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
      `from slots.json, then re-run \`${wsCmd("migrate")}\`.`,
  );
}

function migratedEntry(old: OldSlotEntry): WorkspaceEntry {
  const entry: WorkspaceEntry = {
    worktree: old.worktree,
    createdAt: old.createdAt,
    status: old.status,
  };
  if (old.failure) entry.failure = old.failure;
  if (old.extra !== undefined) entry.extra = old.extra;
  return entry;
}

/** The block index the old slot maps to, when the `ports` scheme still fits: `base + perWorkspace × index`. */
function deriveIndex(slotPort: number, ports: ResolvedPortsConfig): number | undefined {
  const offset = slotPort - ports.base;
  if (!Number.isInteger(offset) || offset <= 0 || offset % ports.perWorkspace !== 0) return;
  const index = offset / ports.perWorkspace;
  return index < ports.maxWorkspaces ? index : undefined;
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
  conversion: Conversion,
  translatedDevServers: number,
  hasPurgeInfrastructure: boolean,
): void {
  const entries = Object.entries(conversion.registry.workspaces);
  console.log(`Migrated ${entries.length} workspace(s) to workspaces.json:`);
  for (const [name, entry] of entries) {
    console.log(`  ${name}${entry.main ? " (main)" : ""}  ${entry.worktree}`);
  }
  if (translatedDevServers > 0) {
    console.log(`Translated ${translatedDevServers} dev-server entry(ies).`);
  }
  console.log("Deleted slots.json.");
  printStaleNote(conversion.stale);
  const linked = entries.filter(([, entry]) => entry.main !== true);
  printInfrastructureWarning(hasPurgeInfrastructure, linked.length);
  printBranchesToUpdate(linked);
}

function printStaleNote(stale: string[]): void {
  if (stale.length === 0) return;
  console.log(
    `\nNo port index could be derived for: ${stale.join(", ")} (the old slot does not fit the ` +
      `\`ports\` scheme). Run \`${wsCmd("setup --force")}\` in each of these worktrees.`,
  );
}

function printInfrastructureWarning(hasPurgeInfrastructure: boolean, linkedCount: number): void {
  if (!hasPurgeInfrastructure || linkedCount === 0) return;
  console.log(
    "\nWarning: infrastructure names (containers, volumes) previously derived from the slot can " +
      "no longer be derived. Rename or remove the old-named resources manually, or they will leak.",
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
    `Error: Old registry found at ${slotsPath}. Run \`${wsCmd("migrate")}\` from the main worktree.`,
  );
  process.exit(1);
}
