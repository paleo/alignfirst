import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
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
  it("keeps ordinary projects compatible and distinguishes a collision suffix", () => {
    expect(composeProjectName("Review-ABC")).toBe("review-abc");
    expect(composeProjectName("Review-ABC-deadbeef")).toBe("review-abc-deadbeef");
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
      patch: async (c) => c.replace("1", "2"),
      existing: "patch",
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
      resolveSource: source({ content: "A=1\nB=1\n" }),
      patch: (c) => c.replace(/^B=.*$/m, "B=2"),
      existing: "patch",
      optional: false,
    });
    expect(outcome).toEqual({ kind: "created" });
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("A=1\nB=2\n");
  });

  it("keeps an existing target when the entry has no patch", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "orig\n");
    const resolveSource = noSource();
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource,
      existing: "patch",
      optional: false,
    });
    expect(outcome).toEqual({ kind: "keptExisting" });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("orig\n");
  });

  it("re-applies the patch to an existing target, keeping the rest", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "PORT=1\nCUSTOM=kept\n");
    const resolveSource = noSource();
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource,
      patch: (c) => c.replace(/^PORT=.*$/m, "PORT=2"),
      existing: "patch",
      optional: false,
    });
    expect(outcome).toEqual({ kind: "updated" });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("PORT=2\nCUSTOM=kept\n");
  });

  it("keeps an existing target with the keep policy, without patching it", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "PORT=1\n");
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: noSource(),
      patch: (c) => c.replace(/^PORT=.*$/m, "PORT=2"),
      existing: "keep",
      optional: false,
    });
    expect(outcome).toEqual({ kind: "keptExisting" });
    expect(readFileSync(join(cur, "out.txt"), "utf-8")).toBe("PORT=1\n");
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
      existing: "patch",
      optional: false,
    });
    expect(outcome).toEqual({ kind: "upToDate" });
    expect(statSync(target).mtime).toEqual(past);
  });

  it("refuses a patch that is not idempotent on re-apply, leaving the target untouched", async () => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    writeFileSync(target, "PORT=2\n");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(target, past, past);
    const run = copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: noSource(),
      patch: async (c) => `${c}x\n`,
      existing: "patch",
      optional: false,
    });
    await expect(run).rejects.toThrow(WorkspaceError);
    await expect(run).rejects.toThrow(/not idempotent/);
    expect(readFileSync(target, "utf-8")).toBe("PORT=2\n");
    expect(statSync(target).mtime).toEqual(past);
  });

  it("refuses a patch that is not idempotent on create, writing nothing", async () => {
    const cur = tmp();
    const run = copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "PORT=2\n" }),
      patch: (c) => `${c}x\n`,
      existing: "patch",
      optional: false,
    });
    await expect(run).rejects.toThrow(/not idempotent/);
    expect(existsSync(join(cur, "out.txt"))).toBe(false);
  });

  it("refuses a patch that is not idempotent on reseed, leaving the target untouched", async () => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    writeFileSync(target, "orig\n");
    const run = copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "PORT=2\n" }),
      patch: (c) => `${c}x\n`,
      existing: "reseed",
      optional: false,
    });
    await expect(run).rejects.toThrow(/not idempotent/);
    expect(readFileSync(target, "utf-8")).toBe("orig\n");
  });

  it("rejects tracked paths with literal pathspecs, including a tracked parent link", async () => {
    const cur = tmp();
    execFileSync("git", ["init", "-q", cur]);
    writeFileSync(join(cur, "[literal]"), "original");
    mkdirSync(join(cur, "inside"));
    symlinkSync("inside", join(cur, "link"));
    execFileSync("git", ["add", "--", "[literal]", "link"], { cwd: cur });
    for (const path of ["[literal]", "link/out.txt"]) {
      await expect(
        copyAndPatchFile({
          currentWorktree: cur,
          relPath: path,
          resolveSource: source({ content: "overwrite" }),
          existing: "reseed",
          optional: false,
        }),
      ).rejects.toThrow(/tracked/);
    }
    expect(readFileSync(join(cur, "[literal]"), "utf8")).toBe("original");
    expect(existsSync(join(cur, "inside/out.txt"))).toBe(false);
  });

  it("rejects logical and canonical escapes and rechecks links after awaited work", async () => {
    const cur = tmp();
    const outside = tmp();
    symlinkSync(outside, join(cur, "escape"));
    for (const path of ["../escape.txt", "escape/out.txt", join(outside, "out.txt")]) {
      await expect(
        copyAndPatchFile({
          currentWorktree: cur,
          relPath: path,
          resolveSource: source({ content: "overwrite" }),
          existing: "reseed",
          optional: false,
        }),
      ).rejects.toThrow(/escapes/);
    }
    await expect(
      copyAndPatchFile({
        currentWorktree: cur,
        relPath: "later/out.txt",
        resolveSource: async () => {
          await Promise.resolve();
          symlinkSync(outside, join(cur, "later"));
          return { content: "overwrite" };
        },
        existing: "patch",
        optional: false,
      }),
    ).rejects.toThrow(/escapes/);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
  });

  it("rechecks tracked destinations after an awaited transform without writing", async () => {
    const cur = tmp();
    execFileSync("git", ["init", "-q", cur]);
    const target = join(cur, "out.txt");
    writeFileSync(target, "original");
    await expect(
      copyAndPatchFile({
        currentWorktree: cur,
        relPath: "out.txt",
        resolveSource: noSource(),
        patch: async () => {
          await Promise.resolve();
          execFileSync("git", ["add", "out.txt"], { cwd: cur });
          return "updated";
        },
        existing: "patch",
        optional: false,
      }),
    ).rejects.toThrow(/tracked/);
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("reseeds an existing target from its source", async () => {
    const cur = tmp();
    writeFileSync(join(cur, "out.txt"), "orig\n");
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "new\n" }),
      patch: (c) => c,
      existing: "reseed",
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
      existing: "patch",
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
        existing: "patch",
        optional: false,
      }),
    ).rejects.toThrow(WorkspaceError);
    expect(existsSync(join(cur, "out.txt"))).toBe(false);
  });
});
