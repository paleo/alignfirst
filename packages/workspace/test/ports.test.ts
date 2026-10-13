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

const BASE: DevPortsConfig = { first: 47100, last: 47109, names: ["web", "api"] };

describe("resolveDevPortsConfig", () => {
  it("expands single and range exclusions, and defaults the pins to none", () => {
    const resolved = resolveDevPortsConfig({
      ...BASE,
      exclude: [47101, { first: 47104, last: 47105 }],
    });
    expect([...resolved.excluded].sort()).toEqual([47101, 47104, 47105]);
    expect(resolved.mainWorktree).toEqual({});
  });

  it.each([
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
    ["an empty name", { ...BASE, names: ["web", ""] }, /non-empty strings/],
    ["a duplicate name", { ...BASE, names: ["web", "web"] }, /"web" twice/],
    ["a pin of an undeclared name", { ...BASE, mainWorktree: { db: 47100 } }, /absent from/],
    ["a pin outside the range", { ...BASE, mainWorktree: { web: 47200 } }, /must be inside/],
    [
      "an excluded pin",
      { ...BASE, exclude: [47100], mainWorktree: { web: 47100 } },
      /must be inside/,
    ],
    ["a duplicate pin", { ...BASE, mainWorktree: { web: 47100, api: 47100 } }, /twice/],
  ])("rejects %s", (_, config, message) => {
    expect(() => resolveDevPortsConfig(config)).toThrow(ConfigError);
    expect(() => resolveDevPortsConfig(config)).toThrow(message);
  });

  it("rejects a pin on a bad port", () => {
    expect(() =>
      resolveDevPortsConfig({
        first: 5990,
        last: 6010,
        names: ["x11"],
        mainWorktree: { x11: 6000 },
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
    const config = { ...BASE, names: ["web", "db"] };
    expect(await reconcile({ config, stored: { web: 47105, api: 47106 } })).toEqual({
      web: 47105,
      db: 47100,
    });
  });

  it("re-allocates a stored port outside the range, excluded, or bad", async () => {
    const config: DevPortsConfig = {
      first: 5998,
      last: 6004,
      names: ["a", "b", "c"],
      exclude: [5999],
    };
    const ports = await reconcile({ config, stored: { a: 7000, b: 5999, c: 6000 } });
    expect(ports).toEqual({ a: 5998, b: 6001, c: 6002 });
  });

  it("skips excluded and bad ports when allocating", async () => {
    const config: DevPortsConfig = { first: 5999, last: 6003, names: ["a", "b"], exclude: [6001] };
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
    const config = { ...BASE, mainWorktree: { api: 47109 } };
    const ports = await reconcile({ config, isMainWorktree: true, stored: { api: 47103 } });
    expect(ports).toEqual({ web: 47100, api: 47109 });
  });

  it("drops a main stored port that another name pins", async () => {
    const config = { ...BASE, mainWorktree: { api: 47105 } };
    const ports = await reconcile({ config, isMainWorktree: true, stored: { web: 47105 } });
    expect(ports).toEqual({ web: 47100, api: 47105 });
  });

  it("never gives a pinned port to a linked workspace", async () => {
    const config = { ...BASE, mainWorktree: { web: 47100 } };
    expect(await reconcile({ config, stored: { web: 47100 } })).toEqual({
      web: 47101,
      api: 47102,
    });
  });

  it("keeps the pins with empty stored ports, as `--reset-ports` passes", async () => {
    const config = { ...BASE, mainWorktree: { web: 47107 } };
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
    const config: DevPortsConfig = { first: 47100, last: 47101, names: ["web", "api"] };
    const attempt = reconcile({ config, others: [47101] });
    await expect(attempt).rejects.toThrow(WorkspaceError);
    await expect(reconcile({ config, others: [47101] })).rejects.toThrow(
      /47100\.\.47101 for "api".*remove/,
    );
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
