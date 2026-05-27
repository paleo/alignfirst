import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { allPorts, isValidPort, type PortScheme } from "./ports.js";
import { getWorktreeBranch } from "./worktree.js";

const SLOTS_FILENAME = "slots.json";

export interface ResolvedSlot {
  slot: number;
  worktree: string;
  owner?: string;
  /** `true` when this slot is the main worktree. */
  main?: boolean;
}

export type SlotStatus = "pending" | "ready" | "failed";

export interface SlotEntry {
  worktree: string;
  owner?: string;
  createdAt: string;
  status: SlotStatus;
  failure?: { at: string; message: string };
  /** `true` for the main-worktree entry. Absent on linked entries. */
  main?: boolean;
}

export interface SlotsRegistry {
  slots: Record<string, SlotEntry>;
}

export function readSlots(mainWorktree: string, registryDir: string): SlotsRegistry {
  const filePath = join(mainWorktree, registryDir, SLOTS_FILENAME);
  if (!existsSync(filePath)) return { slots: {} };
  return JSON.parse(readFileSync(filePath, "utf-8")) as SlotsRegistry;
}

export function writeSlots(
  mainWorktree: string,
  registryDir: string,
  registry: SlotsRegistry,
): void {
  const filePath = join(mainWorktree, registryDir, SLOTS_FILENAME);
  mkdirSync(join(mainWorktree, registryDir), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(registry, undefined, 2)}\n`);
}

export interface RegisterSlotInput {
  slot?: string;
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  scheme: PortScheme;
  requestedOwner?: string;
  /** When `true`, the slot is forced to `scheme.basePort` regardless of `slot` arg. */
  isMainWorktree: boolean;
  /** When `true`, an existing `ready` slot is reset to `pending` so the re-finalize is observable. */
  force?: boolean;
}

export function resolveAndRegisterSlot(input: RegisterSlotInput): {
  port: number;
  owner: string | undefined;
  status: SlotStatus;
} {
  const registry = readSlots(input.mainWorktree, input.registryDir);
  const port = pickSlotPort(input, registry);
  const existing = registry.slots[String(port)];
  const owner = input.requestedOwner ?? existing?.owner;
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  // Re-runs of `workspace setup` keep a previously finalized slot ready, unless `--force` is set —
  // then we reset to pending so `workspace wait` blocks and `dev:up` refuses during the re-finalize.
  const status: SlotStatus = existing?.status === "ready" && !input.force ? "ready" : "pending";
  const entry: SlotEntry = {
    worktree: input.currentWorktree,
    createdAt,
    status,
  };
  if (input.isMainWorktree) entry.main = true;
  if (owner !== undefined) entry.owner = owner;
  registry.slots[String(port)] = entry;
  writeSlots(input.mainWorktree, input.registryDir, registry);
  return { port, owner, status };
}

export function markSlotReady(mainWorktree: string, registryDir: string, slotPort: number): void {
  const registry = readSlots(mainWorktree, registryDir);
  const entry = registry.slots[String(slotPort)];
  if (!entry) return;
  entry.status = "ready";
  delete entry.failure;
  writeSlots(mainWorktree, registryDir, registry);
}

export function markSlotFailed(
  mainWorktree: string,
  registryDir: string,
  slotPort: number,
  message: string,
): void {
  const registry = readSlots(mainWorktree, registryDir);
  const entry = registry.slots[String(slotPort)];
  if (!entry) return;
  entry.status = "failed";
  entry.failure = { at: new Date().toISOString(), message };
  writeSlots(mainWorktree, registryDir, registry);
}

export function validateSlotAvailability(
  slotArg: string | undefined,
  ctx: {
    currentWorktree: string;
    mainWorktree: string;
    registryDir: string;
    scheme: PortScheme;
  },
): void {
  if (slotArg === undefined) return;
  const port = Number(slotArg);
  if (!isValidPort(port, ctx.scheme)) {
    console.error(`Error: Slot must be a valid port: ${allPorts(ctx.scheme).join(", ")}.`);
    process.exit(1);
  }
  const registry = readSlots(ctx.mainWorktree, ctx.registryDir);
  const existing = registry.slots[String(port)];
  if (existing && resolve(existing.worktree) !== resolve(ctx.currentWorktree)) {
    const existingBranch = getWorktreeBranch(existing.worktree);
    console.error(
      `Error: Slot ${port} is already taken by ${existing.worktree} (branch: ${existingBranch ?? "(detached)"}).`,
    );
    process.exit(1);
  }
}

export function resolveCurrentSlot(basePort: number, registryDir: string): ResolvedSlot {
  const slot = lookupSlotForCwd(registryDir) ?? synthesizeMainSlot(basePort);
  if (!slot) {
    console.error("Error: No workspace here. Run `workspace setup` first.");
    process.exit(1);
  }
  return slot;
}

export interface SetOwnerInput {
  newOwner: string | undefined;
  currentWorktree: string;
  mainWorktree: string;
  registryDir: string;
  isMainWorktree: boolean;
}

export function handleSetOwner(input: SetOwnerInput): {
  slotPort: string;
  owner: string | undefined;
} {
  if (input.isMainWorktree) {
    console.error("Error: `workspace set-owner` must be run from a linked worktree.");
    process.exit(1);
  }
  const registry = readSlots(input.mainWorktree, input.registryDir);
  const resolvedCurrent = resolve(input.currentWorktree);
  const entry = Object.entries(registry.slots).find(
    ([, v]) => resolve(v.worktree) === resolvedCurrent,
  );
  if (!entry) {
    console.error("Error: No slot found for this worktree in the registry.");
    process.exit(1);
  }
  const [slotPort, slotData] = entry;
  const updated: SlotEntry = {
    worktree: slotData.worktree,
    createdAt: slotData.createdAt,
    status: slotData.status,
  };
  if (slotData.failure) updated.failure = slotData.failure;
  if (input.newOwner !== undefined) updated.owner = input.newOwner;
  registry.slots[slotPort] = updated;
  writeSlots(input.mainWorktree, input.registryDir, registry);
  return { slotPort, owner: input.newOwner };
}

interface PickSlotArgs {
  slot?: string;
  currentWorktree: string;
  mainWorktree: string;
  scheme: PortScheme;
  isMainWorktree: boolean;
}

function pickSlotPort(args: PickSlotArgs, registry: SlotsRegistry): number {
  const resolvedCurrent = resolve(args.currentWorktree);

  if (args.isMainWorktree) return args.scheme.basePort;

  if (args.slot !== undefined) {
    const port = Number(args.slot);
    if (!isValidPort(port, args.scheme)) {
      console.error(`Error: Slot must be a valid port: ${allPorts(args.scheme).join(", ")}.`);
      process.exit(1);
    }
    const existing = registry.slots[String(port)];
    if (existing && resolve(existing.worktree) !== resolvedCurrent) {
      const existingBranch = getWorktreeBranch(existing.worktree);
      console.error(
        `Error: Slot ${port} is already taken by ${existing.worktree} (branch: ${existingBranch ?? "(detached)"}).`,
      );
      process.exit(1);
    }
    return port;
  }

  const existingEntry = Object.entries(registry.slots).find(
    ([, v]) => resolve(v.worktree) === resolvedCurrent,
  );
  if (existingEntry) return Number(existingEntry[0]);

  for (const port of allPorts(args.scheme)) {
    if (!registry.slots[String(port)]) return port;
  }
  console.error("Error: All slots are taken. Remove a workspace with `workspace remove` first.");
  process.exit(1);
}

function lookupSlotForCwd(registryDir: string): ResolvedSlot | undefined {
  const cwd = resolve(process.cwd());
  // Reads slots.json relative to cwd's shared-dir symlink (so works in linked worktrees too).
  const filePath = join(registryDir, SLOTS_FILENAME);
  if (!existsSync(filePath)) return undefined;
  const registry = JSON.parse(readFileSync(filePath, "utf-8")) as SlotsRegistry;
  for (const [port, entry] of Object.entries(registry.slots)) {
    if (resolve(entry.worktree) === cwd) {
      const resolved: ResolvedSlot = {
        slot: Number(port),
        worktree: entry.worktree,
        owner: entry.owner,
      };
      if (entry.main) resolved.main = true;
      return resolved;
    }
  }
  return undefined;
}

function synthesizeMainSlot(basePort: number): ResolvedSlot | undefined {
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf-8" },
  ).trim();
  const mainWorktree = dirname(gitCommonDir);
  const cwd = resolve(process.cwd());
  if (resolve(mainWorktree) !== cwd) return undefined;
  return { slot: basePort, worktree: cwd, main: true };
}
