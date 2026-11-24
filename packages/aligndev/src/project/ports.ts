import type { ProjectInventory } from "./discovery.js";
import { formatRange } from "./format.js";

export interface PortRange {
  first: number;
  last: number;
}

interface AllocatedPortRange {
  end: number;
  start: number;
}

// The lowest block of `size` ports inside `available` that overlaps no project range.
export function findFreeBlock(
  inventory: ProjectInventory,
  available: PortRange,
  size: number,
): PortRange {
  const occupied = inventory.projects.flatMap(({ portRange }) =>
    portRange === undefined ? [] : [allocatedRange(portRange)],
  );
  const first = lowestFreeBase(occupied, size, available.first, available.last);
  if (first === undefined) {
    throw new Error(`No block of ${size} contiguous free ports in ${formatRange(available)}.`);
  }
  return { first, last: first + size - 1 };
}

function allocatedRange(range: PortRange): AllocatedPortRange {
  return { start: range.first, end: range.last };
}

function lowestFreeBase(
  ranges: readonly AllocatedPortRange[],
  size: number,
  firstPort: number,
  lastPort: number,
): number | undefined {
  let candidate = firstPort;
  for (const range of ranges.toSorted((left, right) => left.start - right.start)) {
    if (range.end < candidate) continue;
    if (range.start > lastPort) break;
    if (fitsBefore(candidate, size, range.start - 1)) return candidate;
    candidate = Math.max(candidate, range.end + 1);
  }
  return fitsBefore(candidate, size, lastPort) ? candidate : undefined;
}

function fitsBefore(basePort: number, size: number, lastPort: number): boolean {
  const end = basePort + size - 1;
  return Number.isSafeInteger(end) && end <= lastPort;
}

export function containsRange(available: PortRange, allocation: PortRange): boolean {
  return allocation.first >= available.first && allocation.last <= available.last;
}

export function rangesOverlap(left: PortRange, right: PortRange): boolean {
  return left.first <= right.last && right.first <= left.last;
}
