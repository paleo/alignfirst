import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeProjectName,
  copyAndPatchFile,
  detectCommonJsError,
  extractHost,
  formatDuration,
  lastLines,
  patchEnvFile,
  type ResolvedFileSource,
} from "../src/helpers.js";
import { WorkspaceError } from "../src/errors.js";

describe("patchEnvFile", () => {
  it("replaces an existing line in place", () => {
    const before = "PORT=3000\nNAME=app\n";
    expect(patchEnvFile(before, { PORT: "8100" })).toBe("PORT=8100\nNAME=app\n");
  });

  it("appends when key missing", () => {
    const before = "NAME=app\n";
    expect(patchEnvFile(before, { PORT: "8100" })).toBe("NAME=app\nPORT=8100\n");
  });

  it("ends with a single trailing newline", () => {
    expect(patchEnvFile("KEY=v\n\n\n", { KEY: "x" })).toBe("KEY=x\n");
  });

  it("handles multiple patches at once", () => {
    const out = patchEnvFile("A=1\nB=2\n", { A: "10", C: "30" });
    expect(out).toBe("A=10\nB=2\nC=30\n");
  });
});

describe("extractHost", () => {
  it("falls back to localhost when key absent", () => {
    expect(extractHost("OTHER=x\n", "API_URL")).toBe("localhost");
  });

  it("extracts an IPv4 host", () => {
    expect(extractHost("API_URL=http://1.2.3.4:8001\n", "API_URL")).toBe("1.2.3.4");
  });

  it("extracts a hostname", () => {
    expect(extractHost("API_URL=https://example.com:443\n", "API_URL")).toBe("example.com");
  });

  it("works without a scheme", () => {
    expect(extractHost("HOST=myhost:1000\n", "HOST")).toBe("myhost");
  });

  it("uses custom fallback", () => {
    expect(extractHost("", "API_URL", "fallback.example")).toBe("fallback.example");
  });
});

describe("composeProjectName", () => {
  it("lowercases the name", () => {
    expect(composeProjectName("myrepo-feat-ABC-123")).toBe("myrepo-feat-abc-123");
  });

  it("drops characters outside [a-z0-9_-]", () => {
    expect(composeProjectName("my.repo-v1.2")).toBe("myrepo-v12");
  });

  it("trims leading dashes and underscores", () => {
    expect(composeProjectName("_-.repo")).toBe("repo");
  });
});

describe("detectCommonJsError", () => {
  it("matches nodemon crash", () => {
    expect(detectCommonJsError("foo\n[nodemon] app crashed - waiting\n")).toBe(
      "[nodemon] app crashed",
    );
  });

  it("matches Node.js footer at line start", () => {
    expect(detectCommonJsError("Error: bad\n    at x\nNode.js v24.11.1\n")).toBe("Node.js v");
  });

  it("does not match Node.js v inside another line", () => {
    expect(detectCommonJsError("Running on Node.js v24 (info)")).toBe(false);
  });

  it("matches Cannot find module", () => {
    expect(detectCommonJsError("Error: Cannot find module 'foo'")).toBe(
      "Error: Cannot find module",
    );
  });

  it("matches SyntaxError at line start", () => {
    expect(detectCommonJsError("...\nSyntaxError: Unexpected token\n")).toBe("SyntaxError");
  });

  it("matches UnhandledPromiseRejection", () => {
    expect(detectCommonJsError("UnhandledPromiseRejection: blah")).toBe(
      "UnhandledPromiseRejection",
    );
  });

  it("returns false on clean startup log", () => {
    expect(detectCommonJsError("Server ready on port 3000\n")).toBe(false);
  });
});

describe("lastLines", () => {
  it("returns all lines when fewer than count", () => {
    expect(lastLines("a\nb", 5)).toBe("a\nb");
  });

  it("keeps only the last count lines", () => {
    expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("preserves a trailing newline as an empty last line", () => {
    expect(lastLines("a\nb\n", 2)).toBe("b\n");
  });

  it("returns an empty string for a count of zero or less", () => {
    expect(lastLines("a\nb\nc", 0)).toBe("");
    expect(lastLines("a\nb\nc", -3)).toBe("");
  });
});

describe("formatDuration", () => {
  it("returns 0s for zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("returns 0s for negative input", () => {
    expect(formatDuration(-123)).toBe("0s");
  });

  it("rounds sub-second up to 1s", () => {
    expect(formatDuration(999)).toBe("1s");
  });

  it("formats single seconds unit", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });

  it("formats minutes + seconds", () => {
    expect(formatDuration(252_000)).toBe("4m 12s");
  });

  it("formats hours + minutes", () => {
    expect(formatDuration(11_100_000)).toBe("3h 5m");
  });

  it("formats days + hours", () => {
    expect(formatDuration((2 * 86400 + 7 * 3600) * 1000)).toBe("2d 7h");
  });

  it("drops the zero smaller unit", () => {
    expect(formatDuration(5 * 86400 * 1000)).toBe("5d");
  });
});

describe("copyAndPatchFile", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    dirs.push(dir);
    return dir;
  };
  const source = (resolved: ResolvedFileSource) => async () => resolved;
  const noSource = () => vi.fn(async (): Promise<ResolvedFileSource> => ({ content: "unused\n" }));
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads from a path source and patches it", async () => {
    const cur = tmp();
    const src = join(tmp(), "in.txt");
    writeFileSync(src, "PORT=1\n");
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ path: src }),
      patch: (c) => c.replace("1", "2"),
      force: false,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("PORT=2\n");
  });

  it("uses a content source verbatim through patch", async () => {
    const cur = tmp();
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "A=1\n" }),
      patch: (c) => `${c}B=2\n`,
      force: false,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("A=1\nB=2\n");
  });

  it("keeps an existing target without force when the entry has no patch", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "orig\n");
    const resolveSource = noSource();
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource,
      force: false,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "keptExisting" });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("orig\n");
  });

  it("re-applies the patch to an existing target without force, keeping the rest", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "PORT=1\nCUSTOM=kept\n");
    const resolveSource = noSource();
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource,
      patch: (c) => c.replace(/^PORT=.*$/m, "PORT=2"),
      force: false,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "updated" });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("PORT=2\nCUSTOM=kept\n");
  });

  it("leaves an existing target alone when the patch changes nothing", async () => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    writeFileSync(target, "PORT=2\n");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(target, past, past);
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: noSource(),
      patch: (c) => c.replace(/^PORT=.*$/m, "PORT=2"),
      force: false,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "upToDate" });
    expect(statSync(target).mtime).toEqual(past);
  });

  it("refuses a patch that is not idempotent, leaving the target untouched", async () => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    writeFileSync(target, "PORT=2\n");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(target, past, past);
    const run = copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: noSource(),
      patch: (c) => `${c}x\n`,
      force: false,
      optional: false,
    });
    await expect(run).rejects.toThrow(WorkspaceError);
    await expect(run).rejects.toThrow(/not idempotent/);
    expect(readFileSync(target, "utf-8")).toBe("PORT=2\n");
    expect(statSync(target).mtime).toEqual(past);
  });

  it("overwrites the target with force", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "orig\n");
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "new\n" }),
      patch: (c) => c,
      force: true,
      optional: false,
    });
    expect(outcome).toEqual({ kind: "overwritten" });
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("new\n");
  });

  it("skips an optional path source that is missing", async () => {
    const cur = tmp();
    const sourcePath = join(cur, "nope.txt");
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ path: sourcePath }),
      patch: (c) => c,
      force: false,
      optional: true,
    });
    expect(outcome).toEqual({ kind: "sourceMissing", sourcePath });
    expect(existsSync(join(cur, "out.txt"))).toBe(false);
  });

  it("throws a WorkspaceError on a missing required path source", async () => {
    const cur = tmp();
    await expect(
      copyAndPatchFile({
        currentWorktree: cur,
        relPath: "out.txt",
        resolveSource: source({ path: join(cur, "nope.txt") }),
        patch: (c) => c,
        force: false,
        optional: false,
      }),
    ).rejects.toThrow(WorkspaceError);
    expect(existsSync(join(cur, "out.txt"))).toBe(false);
  });
});
