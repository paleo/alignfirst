import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { allPorts, isValidPort, type PortScheme } from "./ports.js";

export const WORKTREES_DIR = ".local/worktrees";
export const SLOTS_FILE = ".local/worktrees/slots.json";

export interface SlotEntry {
  worktree: string;
  branch: string;
  owner?: string;
}

export interface SlotsRegistry {
  slots: Record<string, SlotEntry>;
}

export interface ResolvedSlot {
  slot: number;
  worktree: string;
  branch: string;
  owner?: string;
}

export function readSlots(mainWorktree: string): SlotsRegistry {
  const filePath = join(mainWorktree, SLOTS_FILE);
  if (!existsSync(filePath)) return { slots: {} };
  return JSON.parse(readFileSync(filePath, "utf-8")) as SlotsRegistry;
}

export function writeSlots(mainWorktree: string, registry: SlotsRegistry): void {
  const filePath = join(mainWorktree, SLOTS_FILE);
  mkdirSync(join(mainWorktree, WORKTREES_DIR), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(registry, undefined, 2)}\n`);
}

export interface PickSlotArgs {
  slot?: string;
  currentWorktree: string;
  mainWorktree: string;
  scheme: PortScheme;
}

export function pickSlotPort(args: PickSlotArgs, registry: SlotsRegistry): number {
  const resolvedCurrent = resolve(args.currentWorktree);

  if (args.slot !== undefined) {
    const port = Number(args.slot);
    if (!isValidPort(port, args.scheme)) {
      console.error(`Error: Slot must be a valid port: ${allPorts(args.scheme).join(", ")}.`);
      process.exit(1);
    }
    const existing = registry.slots[String(port)];
    if (existing && resolve(existing.worktree) !== resolvedCurrent) {
      console.error(
        `Error: Slot ${port} is already taken by ${existing.worktree} (branch: ${existing.branch}).`,
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
  console.error("Error: All slots are taken. Remove a worktree with --remove first.");
  process.exit(1);
}

export interface RegisterSlotInput {
  slot?: string;
  currentWorktree: string;
  mainWorktree: string;
  scheme: PortScheme;
  branch: string;
  requestedOwner?: string;
}

export function resolveAndRegisterSlot(input: RegisterSlotInput): {
  port: number;
  owner: string | undefined;
} {
  const registry = readSlots(input.mainWorktree);
  const port = pickSlotPort(input, registry);
  const existing = registry.slots[String(port)];
  const owner = input.requestedOwner ?? existing?.owner;
  const entry: SlotEntry = {
    worktree: input.currentWorktree,
    branch: input.branch,
  };
  if (owner !== undefined) entry.owner = owner;
  registry.slots[String(port)] = entry;
  writeSlots(input.mainWorktree, registry);
  return { port, owner };
}

export function validateSlotAvailability(
  slotArg: string | undefined,
  ctx: { currentWorktree: string; mainWorktree: string; scheme: PortScheme },
): void {
  if (slotArg === undefined) return;
  const port = Number(slotArg);
  if (!isValidPort(port, ctx.scheme)) {
    console.error(`Error: Slot must be a valid port: ${allPorts(ctx.scheme).join(", ")}.`);
    process.exit(1);
  }
  const registry = readSlots(ctx.mainWorktree);
  const existing = registry.slots[String(port)];
  if (existing && resolve(existing.worktree) !== resolve(ctx.currentWorktree)) {
    console.error(
      `Error: Slot ${port} is already taken by ${existing.worktree} (branch: ${existing.branch}).`,
    );
    process.exit(1);
  }
}

export function lookupSlotForCwd(): ResolvedSlot | undefined {
  const cwd = resolve(process.cwd());
  // Reads slots.json relative to cwd's `.local` symlink (so works in linked worktrees too).
  const filePath = SLOTS_FILE;
  if (!existsSync(filePath)) return undefined;
  const registry = JSON.parse(readFileSync(filePath, "utf-8")) as SlotsRegistry;
  for (const [port, entry] of Object.entries(registry.slots)) {
    if (resolve(entry.worktree) === cwd) {
      return {
        slot: Number(port),
        worktree: entry.worktree,
        branch: entry.branch,
        owner: entry.owner,
      };
    }
  }
  return undefined;
}

export function synthesizeMainSlot(basePort: number): ResolvedSlot | undefined {
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf-8" },
  ).trim();
  const mainWorktree = dirname(gitCommonDir);
  const cwd = resolve(process.cwd());
  if (resolve(mainWorktree) !== cwd) return undefined;
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
  return { slot: basePort, worktree: cwd, branch };
}

export function resolveCurrentSlot(basePort: number): ResolvedSlot {
  const slot = lookupSlotForCwd() ?? synthesizeMainSlot(basePort);
  if (!slot) {
    console.error("Error: No slot found for this worktree. Run setup-worktree first.");
    process.exit(1);
  }
  return slot;
}

export interface SetOwnerInput {
  newOwner: string | undefined;
  currentWorktree: string;
  mainWorktree: string;
  isMainWorktree: boolean;
}

export function handleSetOwner(input: SetOwnerInput): {
  slotPort: string;
  owner: string | undefined;
} {
  if (input.isMainWorktree) {
    console.error("Error: --set-owner must be run from a linked worktree.");
    process.exit(1);
  }
  const registry = readSlots(input.mainWorktree);
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
    branch: slotData.branch,
  };
  if (input.newOwner !== undefined) updated.owner = input.newOwner;
  registry.slots[slotPort] = updated;
  writeSlots(input.mainWorktree, registry);
  return { slotPort, owner: input.newOwner };
}
