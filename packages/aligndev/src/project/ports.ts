import type { ProjectInventory } from "./discovery.js";
import { formatRange } from "./format.js";
import { MARKER_FILENAME, type MarkerPortRange, type PortRange } from "./markers.js";

interface AllocatedPortRange {
  end: number;
  start: number;
}

export function findFreeBlock(inventory: ProjectInventory, size: number, code?: string): PortRange {
  const rootRanges = inventory.directories.find(({ path }) => path === inventory.root)?.portRanges;
  const markerPath = `${inventory.root}/${MARKER_FILENAME}`;
  if (rootRanges === undefined) throw new Error(`${markerPath} has no portRanges.`);
  const rootRange = selectPortRange(rootRanges, code, markerPath);
  const occupied = [
    ...inventory.projects.flatMap(({ portRange }) =>
      portRange === undefined ? [] : [allocatedRange(portRange)],
    ),
    ...inventory.directories.flatMap(({ path, portRanges }) =>
      path === inventory.root
        ? []
        : (portRanges ?? []).map((portRange) => allocatedRange(portRange)),
    ),
  ];
  const first = lowestFreeBase(occupied, size, rootRange.first, rootRange.last);
  if (first === undefined) {
    throw new Error(`No block of ${size} contiguous free ports in ${formatRange(rootRange)}.`);
  }
  return { first, last: first + size - 1 };
}

function selectPortRange(
  ranges: MarkerPortRange[],
  code: string | undefined,
  markerPath: string,
): MarkerPortRange {
  const declaredCodes = ranges.flatMap((range) => (range.code === undefined ? [] : [range.code]));
  if (code !== undefined) {
    const selected = ranges.find((range) => range.code === code);
    if (selected !== undefined) return selected;
    throw new Error(
      `Unknown port range code ${JSON.stringify(code)} in ${markerPath}; ` +
        `declared codes: ${declaredCodes.join(", ")}`,
    );
  }
  const defaultRange = ranges.find((range) => range.code === undefined);
  if (defaultRange !== undefined) return defaultRange;
  throw new Error(
    `${markerPath} declares no default range: pass --range <code> ` +
      `(codes: ${declaredCodes.join(", ")})`,
  );
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
