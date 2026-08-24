import { AlprojectError } from "./errors.js";
import type { PortRange } from "./config.js";
import type { PortAllocation, ProjectEntry } from "./registry.js";

export interface PortRequest {
  maxWorkspaces: number;
  portsPerWorkspace: number;
}

interface AllocatedPortRange {
  end: number;
  start: number;
}

export function allocateProjectPorts(
  projects: readonly ProjectEntry[],
  request: PortRequest,
  availableRanges: readonly PortRange[],
): PortAllocation {
  const size = projectPortCount(request);
  const allocations = projects.flatMap((project) =>
    project.ports === undefined ? [] : [allocationRange(project.ports)],
  );
  for (const range of availableRanges.toSorted((left, right) => left.first - right.first)) {
    const basePort = lowestFreeBase(allocations, size, range.first, range.last);
    if (basePort !== undefined) return { basePort, ...request };
  }
  throw new AlprojectError(
    "registry",
    `No contiguous block of ${size} ports is available within ${formatPortRanges(availableRanges)}`,
  );
}

export function claimProjectPorts(
  projects: readonly ProjectEntry[],
  claim: PortAllocation,
  availableRanges: readonly PortRange[],
): PortAllocation {
  const claimedRange = allocationRange(claim);
  if (!availableRanges.some((range) => containsRange(range, claimedRange))) {
    throw new AlprojectError(
      "registry",
      `Claimed port range ${formatAllocatedRange(claimedRange)} is outside ${formatPortRanges(availableRanges)}`,
    );
  }
  const conflict = projects.find(
    (project) =>
      project.ports !== undefined && rangesOverlap(claimedRange, allocationRange(project.ports)),
  );
  if (conflict !== undefined) {
    throw new AlprojectError(
      "registry",
      `Claimed port range ${formatAllocatedRange(claimedRange)} is not available because it overlaps ${conflict.path}`,
    );
  }
  return claim;
}

export function projectPortCount(request: PortRequest): number {
  assertPositiveSafeInteger(request.portsPerWorkspace, "portsPerWorkspace");
  assertPositiveSafeInteger(request.maxWorkspaces, "maxWorkspaces");
  const size = request.portsPerWorkspace * request.maxWorkspaces;
  if (!Number.isSafeInteger(size)) {
    throw new AlprojectError("registry", "Requested port allocation size exceeds safe arithmetic");
  }
  return size;
}

export function allocationEnd(allocation: PortAllocation): number {
  assertPositiveSafeInteger(allocation.basePort, "basePort");
  const size = projectPortCount(allocation);
  if (allocation.basePort > Number.MAX_SAFE_INTEGER - size + 1) {
    throw new AlprojectError("registry", "Requested port allocation end exceeds safe arithmetic");
  }
  return allocation.basePort + size - 1;
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
    candidate = range.end + 1;
  }
  return fitsBefore(candidate, size, lastPort) ? candidate : undefined;
}

function fitsBefore(basePort: number, size: number, lastPort: number): boolean {
  const end = basePort + size - 1;
  return Number.isSafeInteger(end) && end <= lastPort;
}

function allocationRange(allocation: PortAllocation): AllocatedPortRange {
  return { end: allocationEnd(allocation), start: allocation.basePort };
}

function containsRange(available: PortRange, allocation: AllocatedPortRange): boolean {
  return allocation.start >= available.first && allocation.end <= available.last;
}

function rangesOverlap(left: AllocatedPortRange, right: AllocatedPortRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function formatPortRanges(ranges: readonly PortRange[]): string {
  if (ranges.length === 0) return "the configured port ranges (none available)";
  return ranges.map((range) => `${range.first}..${range.last}`).join(", ");
}

function formatAllocatedRange(range: AllocatedPortRange): string {
  return `${range.start}..${range.end}`;
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AlprojectError("registry", `${field} must be a positive integer`);
  }
}
