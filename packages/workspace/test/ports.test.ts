import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import { firstPortOf, type PortsConfig, portsForIndex, resolvePortsConfig } from "../src/ports.js";

describe("resolvePortsConfig", () => {
  it("defaults `perWorkspace` to the number of names", () => {
    const resolved = resolvePortsConfig({ base: 8100, maxWorkspaces: 20, names: ["web", "db"] });
    expect(resolved.perWorkspace).toBe(2);
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
    expect(() => resolvePortsConfig({ base: 8100, maxWorkspaces: 20 })).toThrow(ConfigError);
    expect(() => resolvePortsConfig({ base: 8100, maxWorkspaces: 20, names: [] })).toThrow(
      ConfigError,
    );
  });

  it("rejects a config with both `names` and `compute`", () => {
    expect(() =>
      resolvePortsConfig({
        base: 8100,
        maxWorkspaces: 20,
        names: ["web"],
        compute: () => ({ web: 1 }),
      }),
    ).toThrow(ConfigError);
  });

  it("requires `base`", () => {
    // Plain-JS consumers bypass the type, so the guard is a runtime check.
    expect(() => resolvePortsConfig({ maxWorkspaces: 20, names: ["web"] } as PortsConfig)).toThrow(
      /base/,
    );
  });

  it("requires `maxWorkspaces`", () => {
    expect(() => resolvePortsConfig({ base: 8100, names: ["web"] } as PortsConfig)).toThrow(
      /maxWorkspaces/,
    );
  });

  it("requires `perWorkspace` with `compute`", () => {
    expect(() =>
      resolvePortsConfig({ base: 8100, maxWorkspaces: 20, compute: () => ({ web: 8100 }) }),
    ).toThrow(/perWorkspace/);
  });

  it("rejects more names than `perWorkspace`", () => {
    expect(() =>
      resolvePortsConfig({
        base: 8100,
        perWorkspace: 2,
        maxWorkspaces: 20,
        names: ["a", "b", "c"],
      }),
    ).toThrow(/more than/);
  });
});

describe("portsForIndex", () => {
  const named = resolvePortsConfig({
    base: 8100,
    perWorkspace: 10,
    maxWorkspaces: 20,
    names: ["server", "frontend", "db"],
  });

  it("maps names to consecutive ports from the block's first port", () => {
    expect(portsForIndex(named, 0)).toEqual({ server: 8100, frontend: 8101, db: 8102 });
    expect(portsForIndex(named, 2)).toEqual({ server: 8120, frontend: 8121, db: 8122 });
  });

  it("spaces blocks by `perWorkspace`", () => {
    const spaced = resolvePortsConfig({
      base: 9000,
      perWorkspace: 5,
      maxWorkspaces: 20,
      names: ["web"],
    });
    expect(portsForIndex(spaced, 3)).toEqual({ web: 9015 });
  });

  it("hands the index and first port to `compute`", () => {
    const computed = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      compute: ({ index, firstPort }) => ({ web: firstPort, debug: firstPort + 5 + (index % 2) }),
    });
    expect(portsForIndex(computed, 2)).toEqual({ web: 8120, debug: 8125 });
  });

  it("rejects a computed port outside the workspace's block", () => {
    const escaping = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      compute: ({ index, firstPort }) => ({ web: firstPort, debug: 9000 + index }),
    });
    expect(() => portsForIndex(escaping, 0)).toThrow(/outside the workspace's block/);
  });
});

describe("firstPortOf", () => {
  it("returns the base port for the main worktree's block", () => {
    const resolved = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      names: ["web"],
    });
    expect(firstPortOf(resolved, 0)).toBe(8100);
    expect(firstPortOf(resolved, 4)).toBe(8140);
  });
});
