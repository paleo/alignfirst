import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { ConfigError, WorkspaceError } from "../src/errors.js";
import {
  type DevPortsConfig,
  isPortFree,
  type ReconcileInput,
  reconcilePorts,
  resolveDevPortsConfig,
} from "../src/ports.js";

const BASE: DevPortsConfig = { first: 47100, last: 47109, declare: ["web", "api"] };
const RANGED: DevPortsConfig = {
  first: 47100,
  last: 47119,
  declare: [{ name: "front", range: { first: 47100, last: 47104 } }, "api", "db"],
};

describe("resolveDevPortsConfig", () => {
  const front = (settings: object): object => ({ name: "front", ...settings });

  it.each<[string, object]>([
    ["first greater than last", { ...BASE, first: 47110 }],
    ["an exclusion outside the range", { ...BASE, exclude: [47200] }],
    ["an inverted exclusion range", { ...BASE, exclude: [{ first: 47105, last: 47104 }] }],
    ["a duplicate name", { ...BASE, declare: ["web", "web"] }],
    ["a duplicate name in an object", { ...BASE, declare: ["web", { name: "web" }] }],
    ["an inverted range", { ...BASE, declare: [front({ range: { first: 47103, last: 47102 } })] }],
    [
      "a range outside the project range",
      { ...BASE, declare: [front({ range: { first: 47108, last: 47112 } })] },
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
    ],
    [
      "a fully excluded range",
      {
        ...BASE,
        exclude: [{ first: 47100, last: 47102 }],
        declare: [front({ range: { first: 47101, last: 47102 } })],
      },
    ],
    [
      "a range on a bad port only",
      { first: 5990, last: 6010, declare: [front({ range: { first: 6000, last: 6000 } })] },
    ],
    ["a pin outside the range", { ...BASE, declare: [{ name: "web", mainWorktree: 47200 }] }],
    [
      "an excluded pin",
      { ...BASE, exclude: [47100], declare: [{ name: "web", mainWorktree: 47100 }] },
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
    ],
    [
      "a pin outside its range",
      { ...BASE, declare: [front({ range: { first: 47100, last: 47103 }, mainWorktree: 47105 })] },
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
    ],
    [
      "a pin on a bad port",
      { first: 5990, last: 6010, declare: [{ name: "x11", mainWorktree: 6000 }] },
    ],
  ])("rejects %s", (_, config) => {
    // Semantic rules the manifest schema cannot express.
    expect(() => resolveDevPortsConfig(config as DevPortsConfig)).toThrow(ConfigError);
  });
});

describe("reconcilePorts", () => {
  interface ReconcileCase {
    config?: DevPortsConfig;
    isMainWorktree?: boolean;
    stored?: Record<string, number>;
    others?: number[];
    busy?: number[];
    expected: Record<string, number>;
    probed?: number[];
  }

  it.each<[string, ReconcileCase]>([
    ["allocates the lowest allowed ports in names order", { expected: { web: 47100, api: 47101 } }],
    [
      "keeps valid stored ports without probing them",
      { stored: { web: 47108 }, expected: { web: 47108, api: 47100 }, probed: [47100] },
    ],
    [
      "drops an undeclared name",
      {
        config: { ...BASE, declare: ["web", "db"] },
        stored: { web: 47105, api: 47106 },
        expected: { web: 47105, db: 47100 },
      },
    ],
    [
      "re-allocates stored ports outside the range, excluded or bad, skipping those on allocation",
      {
        config: { first: 5998, last: 6004, declare: ["a", "b", "c"], exclude: [5999] },
        stored: { a: 7000, b: 5999, c: 6000 },
        expected: { a: 5998, b: 6001, c: 6002 },
      },
    ],
    [
      "skips the ports stored on other entries and those the probe finds busy",
      { others: [47100], busy: [47101], expected: { web: 47102, api: 47103 } },
    ],
    [
      "drops a linked workspace's stored port that another entry holds",
      { stored: { web: 47105, api: 47106 }, others: [47105], expected: { web: 47100, api: 47106 } },
    ],
    [
      "keeps the main worktree's stored port that another entry holds",
      {
        isMainWorktree: true,
        stored: { web: 47105, api: 47106 },
        others: [47105],
        expected: { web: 47105, api: 47106 },
      },
    ],
    [
      "assigns main pins whatever is stored, dropping a stored port another name pins",
      {
        config: { ...BASE, declare: ["web", { name: "api", mainWorktree: 47105 }] },
        isMainWorktree: true,
        stored: { web: 47105, api: 47103 },
        expected: { web: 47100, api: 47105 },
      },
    ],
    [
      "never gives a pinned port to a linked workspace",
      {
        config: { ...BASE, declare: [{ name: "web", mainWorktree: 47100 }, "api"] },
        stored: { web: 47100 },
        expected: { web: 47101, api: 47102 },
      },
    ],
    [
      "allocates a ranged name inside its range and other names outside, probing neither twice",
      {
        config: RANGED,
        expected: { front: 47100, api: 47105, db: 47106 },
        probed: [47100, 47105, 47106],
      },
    ],
    [
      "applies exclusions, bad ports, other entries and the probe in both scopes",
      {
        config: {
          first: 5994,
          last: 6010,
          exclude: [5994, 5999],
          declare: [{ name: "front", range: { first: 5999, last: 6004 } }, "api"],
        },
        others: [5995, 6001],
        busy: [5996, 6002],
        expected: { front: 6003, api: 5997 },
      },
    ],
    [
      "re-allocates stored ports on the wrong side of a range",
      {
        config: RANGED,
        stored: { front: 47110, api: 47102 },
        expected: { front: 47100, api: 47105, db: 47106 },
      },
    ],
    [
      "keeps a stored port inside its own range",
      {
        config: RANGED,
        stored: { front: 47103 },
        expected: { front: 47103, api: 47105, db: 47106 },
      },
    ],
    [
      "assigns a main-worktree pin inside its range",
      {
        config: {
          ...RANGED,
          declare: [
            { name: "front", range: { first: 47100, last: 47104 }, mainWorktree: 47102 },
            "api",
          ],
        },
        isMainWorktree: true,
        expected: { front: 47102, api: 47105 },
      },
    ],
  ])("%s", async (_, { busy = [], expected, probed, ...input }) => {
    const probes: number[] = [];
    const isFree = async (port: number): Promise<boolean> => {
      probes.push(port);
      return !busy.includes(port);
    };
    expect(await reconcile({ ...input, isFree })).toEqual(expected);
    if (probed) expect(probes).toEqual(probed);
  });

  it.each<[string, DevPortsConfig, number[]]>([
    ["the project range", { first: 47100, last: 47101, declare: ["web", "api"] }, [47101]],
    [
      "a dedicated range",
      { ...RANGED, declare: [{ name: "front", range: { first: 47100, last: 47101 } }, "api"] },
      [47100, 47101],
    ],
  ])(
    "fails rather than reusing a reserved port when %s is exhausted",
    async (_, config, others) => {
      await expect(reconcile({ config, others })).rejects.toThrow(WorkspaceError);
    },
  );
});

describe("isPortFree", () => {
  it("reports a port held on the loopback as busy, and free once released", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    try {
      expect(await isPortFree(address.port)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await isPortFree(address.port)).toBe(true);
  });
});

function reconcile(
  overrides: Partial<Omit<ReconcileInput, "config">> & { config?: DevPortsConfig } = {},
): Promise<Record<string, number>> {
  return reconcilePorts({
    isMainWorktree: false,
    stored: {},
    others: [],
    isFree: async () => true,
    ...overrides,
    config: resolveDevPortsConfig(overrides.config ?? BASE),
  });
}
