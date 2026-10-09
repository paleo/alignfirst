import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/errors.js";
import {
  firstPortOf,
  portAt,
  type PortsConfig,
  portsForIndex,
  resolvePortsConfig,
} from "../src/ports.js";

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

  it("defaults `layout` to workspaceMajor", () => {
    const resolved = resolvePortsConfig({ base: 8100, maxWorkspaces: 20, names: ["web"] });
    expect(resolved.layout).toBe("workspaceMajor");
  });

  it("rejects an unknown `layout`", () => {
    expect(() =>
      resolvePortsConfig({
        base: 8100,
        maxWorkspaces: 20,
        names: ["web"],
        layout: "diagonal" as PortsConfig["layout"],
      }),
    ).toThrow(/layout/);
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

describe("portsForIndex (serviceMajor)", () => {
  const serviceMajor = resolvePortsConfig({
    base: 8100,
    perWorkspace: 10,
    maxWorkspaces: 20,
    layout: "serviceMajor",
    names: ["server", "frontend", "db"],
  });

  it("gives each name a range of `maxWorkspaces` ports and the workspace its index in each", () => {
    expect(portsForIndex(serviceMajor, 0)).toEqual({ server: 8100, frontend: 8120, db: 8140 });
    expect(portsForIndex(serviceMajor, 2)).toEqual({ server: 8102, frontend: 8122, db: 8142 });
  });

  it("keeps every existing port when a name is appended", () => {
    const extended = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      layout: "serviceMajor",
      names: ["server", "frontend", "db", "mail"],
    });
    expect(portsForIndex(extended, 3)).toEqual({
      ...portsForIndex(serviceMajor, 3),
      mail: 8163,
    });
  });

  it("hands `compute` the index and the port of offset 0", () => {
    const computed = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      layout: "serviceMajor",
      compute: ({ index, firstPort }) => ({
        web: firstPort,
        debug: firstPort + 20 * (5 + (index % 2)),
      }),
    });
    expect(portsForIndex(computed, 2)).toEqual({ web: 8102, debug: 8202 });
  });

  it("rejects a computed port that belongs to another workspace", () => {
    const escaping = resolvePortsConfig({
      base: 8100,
      perWorkspace: 10,
      maxWorkspaces: 20,
      layout: "serviceMajor",
      compute: ({ firstPort }) => ({ web: firstPort, debug: firstPort + 1 }),
    });
    expect(() => portsForIndex(escaping, 0)).toThrow(/outside the workspace's ports/);
  });
});

describe("portAt", () => {
  it("ends both layouts on the same last port", () => {
    const config: PortsConfig = { base: 8100, perWorkspace: 10, maxWorkspaces: 20, names: ["web"] };
    const workspaceMajor = resolvePortsConfig(config);
    const serviceMajor = resolvePortsConfig({ ...config, layout: "serviceMajor" });
    expect(portAt(workspaceMajor, 19, 9)).toBe(8299);
    expect(portAt(serviceMajor, 19, 9)).toBe(8299);
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
