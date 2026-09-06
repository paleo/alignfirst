import type { ProjectInventory } from "./discovery.js";
import { MARKER_FILENAME, type PortRange } from "./markers.js";

interface AllocatedPortRange {
  end: number;
  start: number;
}

export function findFreeBlock(inventory: ProjectInventory, size: number): PortRange {
  const rootRange = inventory.directories.find(({ path }) => path === inventory.root)?.portRange;
  if (rootRange === undefined) {
    throw new Error(`${inventory.root}/${MARKER_FILENAME} has no portRange.`);
  }
  const occupied = [
    ...inventory.projects.flatMap(({ portRange }) =>
      portRange === undefined ? [] : [allocatedRange(portRange)],
    ),
    ...inventory.directories.flatMap(({ path, portRange }) =>
      path === inventory.root || portRange === undefined ? [] : [allocatedRange(portRange)],
    ),
  ];
  const first = lowestFreeBase(occupied, size, rootRange.first, rootRange.last);
  if (first === undefined) {
    throw new Error(
      `No block of ${size} contiguous free ports in ${rootRange.first}..${rootRange.last}.`,
    );
  }
  return { first, last: first + size - 1 };
}

export function containsRange(available: PortRange, allocation: PortRange): boolean {
  return allocation.first >= available.first && allocation.last <= available.last;
}

export function rangesOverlap(left: PortRange, right: PortRange): boolean {
  return left.first <= right.last && right.first <= left.last;
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

function allocatedRange(range: PortRange): AllocatedPortRange {
  return { start: range.first, end: range.last };
}
