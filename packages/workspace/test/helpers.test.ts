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
  lastLines,
  patchEnvFile,
  type ResolvedFileSource,
} from "../src/helpers.js";
import { ConfigError, WorkspaceError } from "../src/errors.js";

describe("patchEnvFile", () => {
  it.each([
    ["KEY=v\n\n\n", { KEY: "x" }, "KEY=x\n"],
    ["A=1\nB=2\n", { A: "10", C: "30" }, "A=10\nB=2\nC=30\n"],
  ])("patches %j with %j", (content, patches, expected) => {
    expect(patchEnvFile(content, patches)).toBe(expected);
  });
});

describe("extractHost", () => {
  it.each<[string, string | undefined, string]>([
    ["OTHER=x\n", undefined, "localhost"],
    ["API_URL=https://example.com:443\n", undefined, "example.com"],
    ["API_URL=myhost:1000\n", undefined, "myhost"],
    ["", "fallback.example", "fallback.example"],
  ])("extracts the host of %j (fallback %s)", (content, fallback, expected) => {
    expect(extractHost(content, "API_URL", fallback)).toBe(expected);
  });
});

describe("composeProjectName", () => {
  it.each([
    ["Review-ABC-deadbeef", "review-abc-deadbeef"],
    ["my.repo-v1.2", "myrepo-v12"],
    ["_-.repo", "repo"],
  ])("derives %s as %s", (name, expected) => {
    expect(composeProjectName(name)).toBe(expected);
  });
});

describe("detectCommonJsError", () => {
  it.each<[string, string | false]>([
    ["foo\n[nodemon] app crashed - waiting\n", "[nodemon] app crashed"],
    ["Error: bad\n    at x\nNode.js v24.11.1\n", "Node.js v"],
    ["Running on Node.js v24 (info)", false],
    ["Error: Cannot find module 'foo'", "Error: Cannot find module"],
    ["...\nSyntaxError: Unexpected token\n", "SyntaxError"],
    ["UnhandledPromiseRejection: blah", "UnhandledPromiseRejection"],
    ["Server ready on port 3000\n", false],
  ])("detects %j as %j", (log, expected) => {
    expect(detectCommonJsError(log)).toBe(expected);
  });
});

describe("lastLines", () => {
  it.each([
    ["a\nb", 5, "a\nb"],
    ["a\nb\nc\nd", 2, "c\nd"],
    ["a\nb\n", 2, "b\n"],
    ["a\nb\nc", 0, ""],
  ])("keeps the last lines of %j for count %i", (content, count, expected) => {
    expect(lastLines(content, count)).toBe(expected);
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
  const setPort2 = (content: string) => content.replace(/^PORT=.*$/m, "PORT=2");
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  interface OutcomeCase {
    existingFile?: string;
    source: { content: string } | "missingPath";
    patch?: (content: string) => string;
    existing: "patch" | "keep" | "reseed";
    optional?: boolean;
    outcome: string;
    written?: string;
  }

  it.each<[string, OutcomeCase]>([
    [
      "creates from a path source through its patch",
      { source: { content: "PORT=1\n" }, patch: setPort2, existing: "patch", outcome: "created" },
    ],
    [
      "keeps an existing file without a patch",
      {
        existingFile: "orig\n",
        source: { content: "new\n" },
        existing: "patch",
        outcome: "keptExisting",
      },
    ],
    [
      "re-applies the patch to an existing file, keeping the rest",
      {
        existingFile: "PORT=1\nCUSTOM=kept\n",
        source: { content: "new\n" },
        patch: setPort2,
        existing: "patch",
        outcome: "updated",
        written: "PORT=2\nCUSTOM=kept\n",
      },
    ],
    [
      "keeps an existing file with the keep policy",
      {
        existingFile: "PORT=1\n",
        source: { content: "new\n" },
        patch: setPort2,
        existing: "keep",
        outcome: "keptExisting",
      },
    ],
    [
      "leaves an existing file untouched when the patch changes nothing",
      {
        existingFile: "PORT=2\n",
        source: { content: "new\n" },
        patch: setPort2,
        existing: "patch",
        outcome: "upToDate",
      },
    ],
    [
      "reseeds an existing file from its source",
      {
        existingFile: "orig\n",
        source: { content: "new\n" },
        patch: (c) => c,
        existing: "reseed",
        outcome: "overwritten",
        written: "new\n",
      },
    ],
    [
      "skips a missing optional path source",
      { source: "missingPath", existing: "patch", optional: true, outcome: "sourceMissing" },
    ],
  ])("%s", async (_, row) => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    const past = new Date("2020-01-01T00:00:00Z");
    if (row.existingFile !== undefined) {
      writeFileSync(target, row.existingFile);
      utimesSync(target, past, past);
    }
    let resolved: ResolvedFileSource;
    if (row.source === "missingPath") resolved = { path: join(cur, "nope.txt") };
    else if (row.existingFile === undefined) {
      const path = join(tmp(), "in.txt");
      writeFileSync(path, row.source.content);
      resolved = { path };
    } else resolved = row.source;
    const resolveSource = vi.fn(async () => resolved);
    const outcome = await copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource,
      patch: row.patch,
      existing: row.existing,
      optional: row.optional ?? false,
    });
    expect(outcome.kind).toBe(row.outcome);
    if (row.existingFile === undefined) {
      expect(existsSync(target)).toBe(row.outcome === "created");
      if (row.outcome === "created") expect(readFileSync(target, "utf8")).toBe("PORT=2\n");
    } else if (row.written === undefined) {
      expect(readFileSync(target, "utf8")).toBe(row.existingFile);
      expect(statSync(target).mtime).toEqual(past);
    } else expect(readFileSync(target, "utf8")).toBe(row.written);
    if (row.existingFile !== undefined && row.existing !== "reseed")
      expect(resolveSource).not.toHaveBeenCalled();
  });

  it.each<["patch" | "reseed", string | undefined]>([
    ["patch", "PORT=2\n"],
    ["patch", undefined],
    ["reseed", "orig\n"],
  ])("refuses a non-idempotent patch (%s over %j) before writing", async (existing, file) => {
    const cur = tmp();
    const target = join(cur, "out.txt");
    if (file !== undefined) writeFileSync(target, file);
    const run = copyAndPatchFile({
      currentWorktree: cur,
      relPath: "out.txt",
      resolveSource: source({ content: "PORT=2\n" }),
      patch: (c) => `${c}x\n`,
      existing,
      optional: false,
    });
    await expect(run).rejects.toThrow(WorkspaceError);
    if (file === undefined) expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target, "utf-8")).toBe(file);
  });

  it.each(["index", "stagedDeletion"])(
    "rejects paths tracked in %s with literal pathspecs, including a tracked parent link",
    async (state) => {
      const cur = tmp();
      execFileSync("git", ["init", "-q", cur]);
      writeFileSync(join(cur, "[literal]"), "original");
      mkdirSync(join(cur, "inside"));
      symlinkSync("inside", join(cur, "link"));
      execFileSync("git", ["add", "--", "[literal]", "link"], { cwd: cur });
      if (state === "stagedDeletion") {
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"],
          { cwd: cur },
        );
        execFileSync("git", ["rm", "--cached", "--", "[literal]", "link"], { cwd: cur });
      }
      for (const path of ["[literal]", "link/out.txt"]) {
        await expect(
          copyAndPatchFile({
            currentWorktree: cur,
            relPath: path,
            resolveSource: source({ content: "overwrite" }),
            existing: "reseed",
            optional: false,
          }),
        ).rejects.toThrow(ConfigError);
      }
      expect(readFileSync(join(cur, "[literal]"), "utf8")).toBe("original");
      expect(existsSync(join(cur, "inside/out.txt"))).toBe(false);
    },
  );

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
      ).rejects.toThrow(ConfigError);
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
    ).rejects.toThrow(ConfigError);
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
    ).rejects.toThrow(ConfigError);
    expect(readFileSync(target, "utf8")).toBe("original");
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
