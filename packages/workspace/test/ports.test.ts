import { describe, expect, it } from "vitest";

import {
  allPorts,
  defaultComputePorts,
  isReservedMainSlot,
  isValidPort,
  resolvePortScheme,
} from "../src/ports.js";

const scheme = resolvePortScheme({ basePort: 8100 });

describe("isValidPort", () => {
  it("accepts in-range step-aligned ports", () => {
    expect(isValidPort(8110, scheme)).toBe(true);
    expect(isValidPort(8200, scheme)).toBe(true);
    expect(isValidPort(8290, scheme)).toBe(true);
  });

  it("rejects below min and above max", () => {
    expect(isValidPort(8100, scheme)).toBe(false);
    expect(isValidPort(8300, scheme)).toBe(false);
  });

  it("rejects off-step ports", () => {
    expect(isValidPort(8115, scheme)).toBe(false);
    expect(isValidPort(8111, scheme)).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(isValidPort(8110.5, scheme)).toBe(false);
    expect(isValidPort(Number.NaN, scheme)).toBe(false);
  });
});

describe("isReservedMainSlot", () => {
  it("accepts only the base port (the main worktree's reserved slot)", () => {
    expect(isReservedMainSlot(8100, scheme)).toBe(true);
    expect(isReservedMainSlot(8110, scheme)).toBe(false);
    expect(isReservedMainSlot(8090, scheme)).toBe(false);
  });

  it("is the slot isValidPort excludes, so the base port stays out of the assignable pool", () => {
    expect(isValidPort(scheme.basePort, scheme)).toBe(false);
    expect(isReservedMainSlot(scheme.basePort, scheme)).toBe(true);
    expect(allPorts(scheme)).not.toContain(scheme.basePort);
  });
});

describe("allPorts", () => {
  it("returns inclusive bounds with the right length", () => {
    const ports = allPorts(scheme);
    expect(ports.length).toBe(scheme.maxSlotCount);
    expect(ports[0]).toBe(8110);
    expect(ports.at(-1)).toBe(8290);
  });

  it("respects custom step and slot count", () => {
    const custom = resolvePortScheme({ basePort: 9000, portStep: 5, maxSlotCount: 3 });
    expect(allPorts(custom)).toEqual([9005, 9010, 9015]);
  });
});

describe("defaultComputePorts", () => {
  it("works for a single name", () => {
    expect(defaultComputePorts(["server"])(8110)).toEqual({ server: 8110 });
  });

  it("works for multiple names", () => {
    expect(defaultComputePorts(["server", "frontend", "db"])(8110)).toEqual({
      server: 8110,
      frontend: 8111,
      db: 8112,
    });
  });

  it("throws for empty names", () => {
    expect(() => defaultComputePorts([])).toThrow();
  });
});
