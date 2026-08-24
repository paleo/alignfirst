import { describe, expect, it } from "vitest";

import {
  allocateProjectPorts,
  allocationEnd,
  claimProjectPorts,
  projectPortCount,
} from "../src/ports.js";
import type { ProjectEntry } from "../src/registry.js";

describe("project port allocation", () => {
  it("allocates the lowest free range independent of registry order", () => {
    const projects = [allocated("/c", 8040, 10), allocated("/a", 8000, 20)];
    expect(allocateProjectPorts(projects, request(10), [range(8000, 8099)])).toEqual({
      basePort: 8020,
      maxWorkspaces: 2,
      portsPerWorkspace: 5,
    });
  });

  it("fits exactly at both inclusive boundaries", () => {
    expect(allocateProjectPorts([], request(10), [range(8000, 8009)]).basePort).toBe(8000);
    expect(
      allocateProjectPorts([allocated("/a", 8000, 10)], request(10), [range(8000, 8019)]).basePort,
    ).toBe(8010);
  });

  it("ignores portless registry entries", () => {
    expect(
      allocateProjectPorts([{ path: "/portless" }], request(10), [range(8000, 8009)]).basePort,
    ).toBe(8000);
  });

  it("reports exhaustion without returning an overlapping range", () => {
    expect(() =>
      allocateProjectPorts([allocated("/a", 8000, 10)], request(2), [range(8000, 8009)]),
    ).toThrow(/No contiguous block/);
  });

  it("allocates across disjoint available ranges", () => {
    expect(
      allocateProjectPorts([allocated("/a", 8000, 10)], request(10), [
        range(8000, 8009),
        range(9000, 9009),
      ]).basePort,
    ).toBe(9000);
  });

  it("claims an exact available range and rejects conflicts or excluded ranges", () => {
    const claim = { basePort: 8020, ...request(10) };
    expect(claimProjectPorts([allocated("/a", 8000, 10)], claim, [range(8000, 8099)])).toEqual(
      claim,
    );
    expect(() =>
      claimProjectPorts([allocated("/a", 8025, 10)], claim, [range(8000, 8099)]),
    ).toThrow(/not available/);
    expect(() => claimProjectPorts([], claim, [range(8030, 8099)])).toThrow(/outside/);
  });

  it("validates multiplication and inclusive-end arithmetic", () => {
    expect(() =>
      projectPortCount({ maxWorkspaces: 2, portsPerWorkspace: Number.MAX_SAFE_INTEGER }),
    ).toThrow(/safe arithmetic/);
    expect(() =>
      allocationEnd({
        basePort: Number.MAX_SAFE_INTEGER,
        maxWorkspaces: 1,
        portsPerWorkspace: 2,
      }),
    ).toThrow(/safe arithmetic/);
    expect(() => projectPortCount({ maxWorkspaces: 0, portsPerWorkspace: 1 })).toThrow(
      /positive integer/,
    );
  });
});

function allocated(path: string, basePort: number, size: number): ProjectEntry {
  return { path, ports: { basePort, maxWorkspaces: 1, portsPerWorkspace: size } };
}

function request(size: number) {
  return { maxWorkspaces: 2, portsPerWorkspace: size / 2 };
}

function range(first: number, last: number) {
  return { first, last };
}
