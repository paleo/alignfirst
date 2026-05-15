import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalCwd, findPortHolder, isPidOurs } from "../src/port-holder.js";

const isUnix = platform() !== "win32";

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
    symlinkSync(real, link);
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
    symlinkSync(real, link);
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
