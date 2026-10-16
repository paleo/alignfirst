import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, WorkspaceError } from "../src/errors.js";
import {
  BAD_PORTS,
  type DevPortsConfig,
  isPortFree,
  type ReconcileInput,
  reconcilePorts,
  resolveDevPortsConfig,
} from "../src/ports.js";

const BASE: DevPortsConfig = { first: 47100, last: 47109, declare: ["web", "api"] };

describe("resolveDevPortsConfig", () => {
  it("expands single and range exclusions, and defaults the settings to none", () => {
    const resolved = resolveDevPortsConfig({
      ...BASE,
      exclude: [47101, { first: 47104, last: 47105 }],
    });
    expect([...resolved.excluded].sort()).toEqual([47101, 47104, 47105]);
    expect(resolved.names).toEqual(["web", "api"]);
    expect(resolved.ranges).toEqual({});
    expect(resolved.mainWorktree).toEqual({});
  });

  it("resolves the names in order, the ranges and the pins of mixed entries", () => {
    const resolved = resolveDevPortsConfig({
      first: 47100,
      last: 47119,
      declare: [
        "web",
        { name: "front", range: { first: 47110, last: 47114 }, mainWorktree: 47110 },
        { name: "api", mainWorktree: 47100 },
        { name: "db" },
      ],
    });
    expect(resolved.names).toEqual(["web", "front", "api", "db"]);
    expect(resolved.ranges).toEqual({ front: { first: 47110, last: 47114 } });
    expect(resolved.mainWorktree).toEqual({ front: 47110, api: 47100 });
  });

  const front = (settings: object): object => ({ name: "front", ...settings });

  it.each<[string, object, RegExp]>([
    ["a non-integer first port", { ...BASE, first: 47100.5 }, /ports\.first/],
    ["a port above 65535", { ...BASE, last: 70000 }, /ports\.last/],
    ["a port 0", { ...BASE, first: 0 }, /ports\.first/],
    ["first greater than last", { ...BASE, first: 47110 }, /greater than/],
    ["an exclusion outside the range", { ...BASE, exclude: [47200] }, /ports\.exclude/],
    [
      "an inverted exclusion range",
      { ...BASE, exclude: [{ first: 47105, last: 47104 }] },
      /ports\.exclude/,
    ],
    [
      "the old `names`",
      { first: 47100, last: 47109, names: ["web"] },
      /`ports\.names` became `ports\.declare`.*"Declare Workspace Ports"/,
    ],
    [
      "the old `mainWorktree`",
      { ...BASE, mainWorktree: { web: 47100 } },
      /`ports\.names` became `ports\.declare`.*"Declare Workspace Ports"/,
    ],
    ["a non-array `declare`", { ...BASE, declare: "web" }, /`ports\.declare` must be an array/],
    ["an empty name", { ...BASE, declare: ["web", ""] }, /`ports\.declare\[1\]`/],
    [
      "an entry without name",
      { ...BASE, declare: [{ mainWorktree: 47100 }] },
      /`ports\.declare\[0\]`/,
    ],
    ["a non-string name", { ...BASE, declare: ["web", { name: 3 }] }, /`ports\.declare\[1\]`/],
    ["a null entry", { ...BASE, declare: [null] }, /`ports\.declare\[0\]`/],
    ["a duplicate name", { ...BASE, declare: ["web", "web"] }, /"web" twice/],
    [
      "a duplicate name in an object",
      { ...BASE, declare: ["web", { name: "web" }] },
      /"web" twice/,
    ],
    [
      "an unknown key",
      { ...BASE, declare: [{ name: "web", port: 47100 }] },
      /"web": unknown key `port`/,
    ],
    [
      "a range that is no object",
      { ...BASE, declare: [front({ range: 47100 })] },
      /"front": `range` must be/,
    ],
    [
      "a range with a non-integer bound",
      { ...BASE, declare: [front({ range: { first: 47100.5, last: 47102 } })] },
      /"front": `range` must be/,
    ],
    [
      "a range without last",
      { ...BASE, declare: [front({ range: { first: 47100 } })] },
      /"front": `range` must be/,
    ],
    [
      "an inverted range",
      { ...BASE, declare: [front({ range: { first: 47103, last: 47102 } })] },
      /"front": `range` 47103\.\.47102 has its first port greater than its last/,
    ],
    [
      "a range outside the project range",
      { ...BASE, declare: [front({ range: { first: 47108, last: 47112 } })] },
      /"front": `range` 47108\.\.47112 must be inside 47100\.\.47109/,
    ],
    [
      "overlapping ranges",
      {
        ...BASE,
        declare: [
          front({ range: { first: 47100, last: 47103 } }),
          { name: "api", range: { first: 47103, last: 47105 } },
        ],
      },
      /"api": `range` 47103\.\.47105 overlaps the range 47100\.\.47103 of "front"/,
    ],
    [
      "a fully excluded range",
      {
        ...BASE,
        exclude: [{ first: 47100, last: 47102 }],
        declare: [front({ range: { first: 47101, last: 47102 } })],
      },
      /"front": `range` 47101\.\.47102 holds no allowed port/,
    ],
    [
      "a range on a bad port only",
      { first: 5990, last: 6010, declare: [front({ range: { first: 6000, last: 6000 } })] },
      /"front": `range` 6000\.\.6000 holds no allowed port/,
    ],
    [
      "a non-integer pin",
      { ...BASE, declare: [{ name: "web", mainWorktree: 47100.5 }] },
      /"web": `mainWorktree` must be an integer port/,
    ],
    [
      "a pin outside the range",
      { ...BASE, declare: [{ name: "web", mainWorktree: 47200 }] },
      /must be inside/,
    ],
    [
      "an excluded pin",
      { ...BASE, exclude: [47100], declare: [{ name: "web", mainWorktree: 47100 }] },
      /must be inside/,
    ],
    [
      "a duplicate pin",
      {
        ...BASE,
        declare: [
          { name: "web", mainWorktree: 47100 },
          { name: "api", mainWorktree: 47100 },
        ],
      },
      /twice/,
    ],
    [
      "a pin outside its range",
      { ...BASE, declare: [front({ range: { first: 47100, last: 47103 }, mainWorktree: 47105 })] },
      /"front": `mainWorktree` \(47105\) must be inside its range 47100\.\.47103\./,
    ],
    [
      "a pin of a name without range inside another range",
      {
        ...BASE,
        declare: [
          front({ range: { first: 47100, last: 47103 } }),
          { name: "api", mainWorktree: 47101 },
        ],
      },
      /"api": `mainWorktree` \(47101\) lies in the range 47100\.\.47103 dedicated to "front"/,
    ],
  ])("rejects %s", (_, config, message) => {
    // Invalid on purpose: the validation guards a JavaScript config the types cannot.
    const untyped = config as DevPortsConfig;
    expect(() => resolveDevPortsConfig(untyped)).toThrow(ConfigError);
    expect(() => resolveDevPortsConfig(untyped)).toThrow(message);
  });

  it("rejects a pin on a bad port", () => {
    expect(() =>
      resolveDevPortsConfig({
        first: 5990,
        last: 6010,
        declare: [{ name: "x11", mainWorktree: 6000 }],
      }),
    ).toThrow(/bad port/);
  });
});

describe("BAD_PORTS", () => {
  it("holds the Fetch Standard's bad ports", () => {
    expect(BAD_PORTS.has(6000)).toBe(true);
    expect(BAD_PORTS.has(10080)).toBe(true);
    expect(BAD_PORTS.has(8100)).toBe(false);
  });
});

describe("reconcilePorts", () => {
  const allFree = async (): Promise<boolean> => true;

  function reconcile(
    overrides: Partial<Omit<ReconcileInput, "config">> & { config?: DevPortsConfig } = {},
  ): Promise<Record<string, number>> {
    return reconcilePorts({
      isMainWorktree: false,
      stored: {},
      others: [],
      isFree: allFree,
      ...overrides,
      config: resolveDevPortsConfig(overrides.config ?? BASE),
    });
  }

  it("allocates the lowest allowed ports in names order", async () => {
    expect(await reconcile()).toEqual({ web: 47100, api: 47101 });
  });

  it("keeps valid stored ports", async () => {
    expect(await reconcile({ stored: { web: 47108, api: 47103 } })).toEqual({
      web: 47108,
      api: 47103,
    });
  });

  it("drops an undeclared name and allocates a new one", async () => {
    const config = { ...BASE, declare: ["web", "db"] };
    expect(await reconcile({ config, stored: { web: 47105, api: 47106 } })).toEqual({
      web: 47105,
      db: 47100,
    });
  });

  it("re-allocates a stored port outside the range, excluded, or bad", async () => {
    const config: DevPortsConfig = {
      first: 5998,
      last: 6004,
      declare: ["a", "b", "c"],
      exclude: [5999],
    };
    const ports = await reconcile({ config, stored: { a: 7000, b: 5999, c: 6000 } });
    expect(ports).toEqual({ a: 5998, b: 6001, c: 6002 });
  });

  it("skips excluded and bad ports when allocating", async () => {
    const config: DevPortsConfig = {
      first: 5999,
      last: 6003,
      declare: ["a", "b"],
      exclude: [6001],
    };
    expect(await reconcile({ config })).toEqual({ a: 5999, b: 6002 });
  });

  it("skips the ports stored on other entries", async () => {
    expect(await reconcile({ others: [47100, 47102] })).toEqual({ web: 47101, api: 47103 });
  });

  it("drops a linked workspace's stored port that another entry holds", async () => {
    expect(await reconcile({ stored: { web: 47105, api: 47106 }, others: [47105] })).toEqual({
      web: 47100,
      api: 47106,
    });
  });

  it("keeps the main worktree's stored port that another entry holds", async () => {
    const ports = await reconcile({
      isMainWorktree: true,
      stored: { web: 47105, api: 47106 },
      others: [47105],
    });
    expect(ports).toEqual({ web: 47105, api: 47106 });
  });

  it("assigns the pins in the main worktree, whatever is stored", async () => {
    const config = { ...BASE, declare: ["web", { name: "api", mainWorktree: 47109 }] };
    const ports = await reconcile({ config, isMainWorktree: true, stored: { api: 47103 } });
    expect(ports).toEqual({ web: 47100, api: 47109 });
  });

  it("drops a main stored port that another name pins", async () => {
    const config = { ...BASE, declare: ["web", { name: "api", mainWorktree: 47105 }] };
    const ports = await reconcile({ config, isMainWorktree: true, stored: { web: 47105 } });
    expect(ports).toEqual({ web: 47100, api: 47105 });
  });

  it("never gives a pinned port to a linked workspace", async () => {
    const config = { ...BASE, declare: [{ name: "web", mainWorktree: 47100 }, "api"] };
    expect(await reconcile({ config, stored: { web: 47100 } })).toEqual({
      web: 47101,
      api: 47102,
    });
  });

  it("keeps the pins with empty stored ports, as `--reset-ports` passes", async () => {
    const config = { ...BASE, declare: [{ name: "web", mainWorktree: 47107 }, "api"] };
    expect(await reconcile({ config, isMainWorktree: true, stored: {} })).toEqual({
      web: 47107,
      api: 47100,
    });
  });

  it("skips the ports the probe finds busy", async () => {
    const busy = new Set([47100, 47101]);
    const isFree = async (port: number): Promise<boolean> => !busy.has(port);
    expect(await reconcile({ isFree })).toEqual({ web: 47102, api: 47103 });
  });

  it("does not probe a kept stored port", async () => {
    const probed: number[] = [];
    const isFree = async (port: number): Promise<boolean> => {
      probed.push(port);
      return true;
    };
    await reconcile({ stored: { web: 47105 }, isFree });
    expect(probed).toEqual([47100]);
  });

  it("fails on an exhausted range, naming it and pointing at `workspace remove`", async () => {
    const config: DevPortsConfig = { first: 47100, last: 47101, declare: ["web", "api"] };
    const attempt = reconcile({ config, others: [47101] });
    await expect(attempt).rejects.toThrow(WorkspaceError);
    await expect(reconcile({ config, others: [47101] })).rejects.toThrow(
      /47100\.\.47101 for "api".*remove/,
    );
  });

  describe("with a dedicated range", () => {
    const RANGED: DevPortsConfig = {
      first: 47100,
      last: 47119,
      declare: [{ name: "front", range: { first: 47100, last: 47104 } }, "api", "db"],
    };

    it("allocates the name inside its range, the other names outside every range", async () => {
      expect(await reconcile({ config: RANGED })).toEqual({ front: 47100, api: 47105, db: 47106 });
    });

    it("never probes a port of a range for another name", async () => {
      const probed: number[] = [];
      const isFree = async (port: number): Promise<boolean> => {
        probed.push(port);
        return true;
      };
      await reconcile({ config: RANGED, isFree });
      expect(probed).toEqual([47100, 47105, 47106]);
    });

    it("applies exclusions, bad ports, other entries and the probe in both scopes", async () => {
      const config: DevPortsConfig = {
        first: 5994,
        last: 6010,
        exclude: [5994, 5999],
        declare: [{ name: "front", range: { first: 5999, last: 6004 } }, "api"],
      };
      const busy = new Set([5996, 6002]);
      const isFree = async (port: number): Promise<boolean> => !busy.has(port);
      const ports = await reconcile({ config, others: [5995, 6001], isFree });
      expect(ports).toEqual({ front: 6003, api: 5997 });
    });

    it("re-allocates a stored port outside its name's range", async () => {
      const ports = await reconcile({ config: RANGED, stored: { front: 47110 } });
      expect(ports).toEqual({ front: 47100, api: 47105, db: 47106 });
    });

    it("re-allocates another name's stored port inside a range", async () => {
      const ports = await reconcile({ config: RANGED, stored: { api: 47102 } });
      expect(ports).toEqual({ front: 47100, api: 47105, db: 47106 });
    });

    it("keeps a stored port inside its own range", async () => {
      const ports = await reconcile({ config: RANGED, stored: { front: 47103 } });
      expect(ports).toEqual({ front: 47103, api: 47105, db: 47106 });
    });

    it("assigns a main-worktree pin inside its range", async () => {
      const config: DevPortsConfig = {
        ...RANGED,
        declare: [
          { name: "front", range: { first: 47100, last: 47104 }, mainWorktree: 47102 },
          "api",
        ],
      };
      expect(await reconcile({ config, isMainWorktree: true })).toEqual({
        front: 47102,
        api: 47105,
      });
    });

    it("fails on an exhausted range with the dedicated-range message", async () => {
      const config: DevPortsConfig = {
        ...RANGED,
        declare: [{ name: "front", range: { first: 47100, last: 47101 } }, "api"],
      };
      const attempt = reconcile({ config, others: [47100, 47101] });
      await expect(attempt).rejects.toThrow(WorkspaceError);
      await expect(reconcile({ config, others: [47100, 47101] })).rejects.toThrow(
        /range 47100\.\.47101 dedicated to "front".*dev.*setup.*remove/,
      );
    });
  });
});

describe("isPortFree", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const held = server;
    server = undefined;
    if (held) await new Promise((resolve) => held.close(resolve));
  });

  it("reports a port held on the loopback as busy, and free once released", async () => {
    server = createServer();
    const held = server;
    await new Promise<void>((resolve) => held.listen({ port: 0, host: "127.0.0.1" }, resolve));
    const address = held.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    expect(await isPortFree(address.port)).toBe(false);

    await new Promise((resolve) => held.close(resolve));
    server = undefined;
    expect(await isPortFree(address.port)).toBe(true);
  });
});
