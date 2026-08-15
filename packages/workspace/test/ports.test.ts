import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import { firstPortOf, portsForIndex, resolvePortsConfig } from "../src/ports.js";

describe("resolvePortsConfig", () => {
  it("applies the default block size and workspace cap", () => {
    const resolved = resolvePortsConfig({ base: 8100, names: ["web"] });
    expect(resolved.perWorkspace).toBe(10);
    expect(resolved.maxWorkspaces).toBe(20);
  });

  it("keeps explicit values", () => {
    const resolved = resolvePortsConfig({
      base: 9000,
      perWorkspace: 5,
      maxWorkspaces: 3,
      names: ["web"],
    });
    expect(resolved).toMatchObject({ base: 9000, perWorkspace: 5, maxWorkspaces: 3 });
  });

  it("rejects a config with neither `names` nor `compute`", () => {
    expect(() => resolvePortsConfig({ base: 8100 })).toThrow(ConfigError);
    expect(() => resolvePortsConfig({ base: 8100, names: [] })).toThrow(ConfigError);
  });

  it("rejects a config with both `names` and `compute`", () => {
    expect(() =>
      resolvePortsConfig({ base: 8100, names: ["web"], compute: () => ({ web: 1 }) }),
    ).toThrow(ConfigError);
  });
});

describe("portsForIndex", () => {
  const named = resolvePortsConfig({ base: 8100, names: ["server", "frontend", "db"] });

  it("maps names to consecutive ports from the block's first port", () => {
    expect(portsForIndex(named, 0)).toEqual({ server: 8100, frontend: 8101, db: 8102 });
    expect(portsForIndex(named, 2)).toEqual({ server: 8120, frontend: 8121, db: 8122 });
  });

  it("spaces blocks by `perWorkspace`", () => {
    const spaced = resolvePortsConfig({ base: 9000, perWorkspace: 5, names: ["web"] });
    expect(portsForIndex(spaced, 3)).toEqual({ web: 9015 });
  });

  it("hands the index and first port to `compute`", () => {
    const computed = resolvePortsConfig({
      base: 8100,
      compute: ({ index, firstPort }) => ({ web: firstPort, debug: 9000 + index }),
    });
    expect(portsForIndex(computed, 2)).toEqual({ web: 8120, debug: 9002 });
  });
});

describe("firstPortOf", () => {
  it("returns the base port for the main worktree's block", () => {
    const resolved = resolvePortsConfig({ base: 8100, names: ["web"] });
    expect(firstPortOf(resolved, 0)).toBe(8100);
    expect(firstPortOf(resolved, 4)).toBe(8140);
  });
});
