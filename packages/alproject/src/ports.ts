import { AlprojectError } from "./errors.js";
import type { PortAllocation, ProjectEntry } from "./registry.js";

export interface PortRequest {
  maxWorkspaces: number;
  portsPerWorkspace: number;
}

interface PortRange {
  end: number;
  start: number;
}

export function allocateProjectPorts(
  projects: readonly ProjectEntry[],
  request: PortRequest,
  firstPort: number,
  lastPort: number,
): PortAllocation {
  const size = projectPortCount(request);
  const ranges = projects.flatMap((project) =>
    project.ports === undefined ? [] : [allocationRange(project.ports)],
  );
  const basePort = lowestFreeBase(ranges, size, firstPort, lastPort);
  if (basePort === undefined) {
    throw new AlprojectError(
      "registry",
      `No contiguous block of ${size} ports is available within ${firstPort}..${lastPort}`,
    );
  }
  return { basePort, ...request };
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
  ranges: readonly PortRange[],
  size: number,
  firstPort: number,
  lastPort: number,
): number | undefined {
  let candidate = firstPort;
  for (const range of ranges.toSorted((left, right) => left.start - right.start)) {
    if (range.end < candidate) continue;
    if (fitsBefore(candidate, size, range.start - 1)) return candidate;
    candidate = range.end + 1;
  }
  return fitsBefore(candidate, size, lastPort) ? candidate : undefined;
}

function fitsBefore(basePort: number, size: number, lastPort: number): boolean {
  const end = basePort + size - 1;
  return Number.isSafeInteger(end) && end <= lastPort;
}

function allocationRange(allocation: PortAllocation): PortRange {
  return { end: allocationEnd(allocation), start: allocation.basePort };
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AlprojectError("registry", `${field} must be a positive integer`);
  }
}
