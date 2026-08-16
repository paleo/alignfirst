import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalCwd,
  detectPortConflicts,
  findPortHolder,
  isPidOurs,
  sweepStalePorts,
  waitForPortsFree,
} from "../src/port-holder.js";
import type { SpawnServer } from "../src/server-descriptor.js";

function spawnServer(name: string, port?: number): SpawnServer {
  const server: SpawnServer = {
    kind: "spawn",
    name,
    exec: { command: "noop", args: [] },
    detectReady: () => true,
  };
  if (port !== undefined) server.port = port;
  return server;
}

const isUnix = platform() !== "win32";
const dirSymlinkType = platform() === "win32" ? "junction" : "dir";

describe("isPidOurs", () => {
  it("matches exact cwd", () => {
    expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: "/a/b" }, "/a/b")).toBe(true);
  });

  it("matches descendant cwd", () => {
    expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: "/a/b/c" }, "/a/b")).toBe(true);
  });

  it("rejects sibling cwd with shared prefix", () => {
    expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: "/a/bb" }, "/a/b")).toBe(false);
  });

  it("rejects outside cwd", () => {
    expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: "/other" }, "/a/b")).toBe(false);
  });

  it("rejects missing cwd", () => {
    expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x" }, "/a/b")).toBe(false);
  });

  it("resolves holder symlink before comparing", () => {
    const real = mkdtempSync(join(tmpdir(), "wt-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link, dirSymlinkType);
    try {
      expect(isPidOurs({ pid: 1, pgid: 1, cmd: "x", cwd: link }, real)).toBe(true);
    } finally {
      unlinkSync(link);
      rmSync(real, { recursive: true });
    }
  });
});

describe("canonicalCwd", () => {
  it("resolves a symlink", () => {
    const real = mkdtempSync(join(tmpdir(), "wt-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link, dirSymlinkType);
    try {
      expect(canonicalCwd(link)).toBe(realpathSync(real));
    } finally {
      unlinkSync(link);
      rmSync(real, { recursive: true });
    }
  });

  it("returns the input when realpath fails", () => {
    expect(canonicalCwd("/nonexistent/path/xyz-zzz")).toBe("/nonexistent/path/xyz-zzz");
  });
});

describe.skipIf(!isUnix)("findPortHolder", () => {
  let server: Server | undefined;
  let port = 0;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    port = addr.port;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
  });

  it("finds the holder of a listening port", () => {
    const holder = findPortHolder(port);
    expect(holder).toBeDefined();
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.cwd).toBeTruthy();
  });

  it("returns undefined for an unused port", () => {
    expect(findPortHolder(1)).toBeUndefined();
  });
});

describe.skipIf(!isUnix)("detectPortConflicts", () => {
  let server: Server | undefined;
  let port = 0;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    port = addr.port;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
  });

  it("returns no conflicts when ports are free", async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const conflicts = await detectPortConflicts(
      [spawnServer("web", port)],
      realpathSync(process.cwd()),
    );
    expect(conflicts).toEqual([]);
  });

  it("classifies a holder in our cwd as 'ours'", async () => {
    const conflicts = await detectPortConflicts(
      [spawnServer("web", port)],
      realpathSync(process.cwd()),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("ours");
    expect(conflicts[0]?.holder?.pid).toBe(process.pid);
  });

  it("classifies a holder outside our cwd as 'foreign'", async () => {
    const conflicts = await detectPortConflicts([spawnServer("web", port)], "/nonexistent-xyz");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("foreign");
  });

  it("skips callback servers", async () => {
    const conflicts = await detectPortConflicts(
      [{ kind: "callback", name: "db", start: async () => {}, stop: async () => {} }],
      realpathSync(process.cwd()),
    );
    expect(conflicts).toEqual([]);
  });

  it("skips spawn servers that declare no port", async () => {
    const conflicts = await detectPortConflicts(
      [spawnServer("worker")],
      realpathSync(process.cwd()),
    );
    expect(conflicts).toEqual([]);
  });

  it("sweeps nothing for a spawn server without a port", async () => {
    await expect(sweepStalePorts([spawnServer("worker")], process.cwd())).resolves.toBeUndefined();
  });
});

describe.skipIf(!isUnix)("waitForPortsFree", () => {
  it("returns [] immediately when no ports are busy", async () => {
    const stillBusy = await waitForPortsFree([1], 200);
    expect(stillBusy).toEqual([]);
  });

  it("returns the port when it stays busy past the deadline", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    try {
      const stillBusy = await waitForPortsFree([addr.port], 200);
      expect(stillBusy).toEqual([addr.port]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns [] once a busy port becomes free before the deadline", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    setTimeout(() => server.close(), 150);
    const stillBusy = await waitForPortsFree([addr.port], 2000);
    expect(stillBusy).toEqual([]);
  });
});
