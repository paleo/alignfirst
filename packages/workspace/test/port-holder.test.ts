import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectPortConflicts,
  findPortHolder,
  isPidOurs,
  waitForPortsFree,
} from "../src/port-holder.js";
import type { ResolvedSpawnServer } from "../src/server-descriptor.js";

const isUnix = platform() !== "win32";
const dirSymlinkType = platform() === "win32" ? "junction" : "dir";
const listeners: Listener[] = [];
const timers: NodeJS.Timeout[] = [];

interface Listener {
  server: Server;
  port: number;
  closed: Promise<void>;
}

function spawnServer(name: string, port?: number): ResolvedSpawnServer {
  const server: ResolvedSpawnServer = {
    kind: "spawn",
    name,
    exec: { command: "noop", args: [], cwd: "/unused", env: {} },
    detectReady: () => true,
  };
  if (port !== undefined) server.port = port;
  return server;
}

describe("isPidOurs", () => {
  it.each<[string, string | undefined, boolean]>([
    ["the exact cwd", "/a/b", true],
    ["a descendant cwd", "/a/b/c", true],
    ["a sibling cwd with a shared prefix", "/a/bb", false],
    ["an outside cwd", "/other", false],
    ["a missing cwd", undefined, false],
    ["a symlinked holder cwd", "link", true],
  ])("classifies %s", (_, cwd, ours) => {
    if (cwd !== "link") {
      expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd }, "/a/b")).toBe(ours);
      return;
    }
    const real = mkdtempSync(join(tmpdir(), "wt-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link, dirSymlinkType);
    try {
      expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: link }, real)).toBe(ours);
    } finally {
      unlinkSync(link);
      rmSync(real, { recursive: true });
    }
  });
});

afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  await Promise.all(listeners.splice(0).map(closeListener));
});

async function listen(): Promise<Listener> {
  const server = createServer();
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const listener = { server, port: address.port, closed };
  listeners.push(listener);
  return listener;
}

async function closeListener(listener: Listener): Promise<void> {
  if (listener.server.listening) listener.server.close();
  await listener.closed;
}

describe.skipIf(!isUnix)("findPortHolder", () => {
  it("finds the holder of a listening port", async () => {
    const { port } = await listen();
    const holder = findPortHolder(port);
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.cwd).toBeTruthy();
  });

  it("returns undefined for an unused port", async () => {
    const listener = await listen();
    await closeListener(listener);
    expect(findPortHolder(listener.port)).toBeUndefined();
  });
});

describe.skipIf(!isUnix)("detectPortConflicts", () => {
  it.each(["free", "ours", "foreign"] as const)("classifies a %s port", async (kind) => {
    const listener = await listen();
    if (kind === "free") await closeListener(listener);
    const root = kind === "foreign" ? "/nonexistent-xyz" : realpathSync(process.cwd());
    const conflicts = await detectPortConflicts([spawnServer("web", listener.port)], root);
    if (kind === "free") expect(conflicts).toEqual([]);
    else expect(conflicts).toMatchObject([{ kind, holder: { pid: process.pid } }]);
  });

  it("skips callback servers and spawn servers without a port", async () => {
    const callback = {
      kind: "callback" as const,
      name: "db",
      start: async () => {},
      stop: async () => {},
    };
    const portless = { ...spawnServer("worker"), port: undefined };
    expect(await detectPortConflicts([callback, portless], realpathSync(process.cwd()))).toEqual(
      [],
    );
  });
});

describe.skipIf(!isUnix)("waitForPortsFree", () => {
  it("returns the port when it stays busy past the deadline", async () => {
    const { port } = await listen();
    expect(await waitForPortsFree([port], 50)).toEqual([port]);
  });

  it("returns [] once a busy port becomes free before the deadline", async () => {
    const listener = await listen();
    timers.push(setTimeout(() => listener.server.close(), 25));
    expect(await waitForPortsFree([listener.port], 2000)).toEqual([]);
  });
});
