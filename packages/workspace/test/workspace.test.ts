import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchWorktreeByDir, type PatchContext, resolveFileSource } from "../src/workspace.js";
import type { WorkspacesRegistry } from "../src/workspaces.js";

let root: string;
let ctx: PatchContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-source-test-"));
  const mainWorktree = join(root, "main");
  const currentWorktree = join(root, "feat");
  mkdirSync(mainWorktree);
  mkdirSync(currentWorktree);
  ctx = {
    name: "repo-feat",
    ports: { server: 8110 },
    mainWorktree,
    currentWorktree,
    isMainWorktree: false,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveFileSource", () => {
  it("reads a `mainWorktree` source at the entry's path in the main worktree", async () => {
    const source = await resolveFileSource({ path: ".env", source: { kind: "mainWorktree" } }, ctx);
    expect(source).toEqual({ path: join(ctx.mainWorktree, ".env") });
  });

  it("prefers an existing main-worktree file over a declared fallback", async () => {
    writeFileSync(join(ctx.mainWorktree, ".env"), "MAIN=1\n");
    writeFileSync(join(ctx.currentWorktree, ".env.example"), "FALLBACK=1\n");

    const source = await resolveFileSource(
      {
        path: ".env",
        source: { kind: "mainWorktree", fallback: ".env.example" },
      },
      ctx,
    );

    expect(source).toEqual({ path: join(ctx.mainWorktree, ".env") });
  });

  it("uses a fallback from the current worktree when the main file is absent", async () => {
    writeFileSync(join(ctx.currentWorktree, ".env.example"), "FALLBACK=1\n");

    const source = await resolveFileSource(
      {
        path: ".env",
        source: { kind: "mainWorktree", fallback: ".env.example" },
      },
      ctx,
    );

    expect(source).toEqual({ path: join(ctx.currentWorktree, ".env.example") });
  });

  it("reads a `committed` source at the template path in the current worktree", async () => {
    const source = await resolveFileSource(
      { path: ".env", source: { kind: "committed", path: ".env.example" } },
      ctx,
    );
    expect(source).toEqual({ path: join(ctx.currentWorktree, ".env.example") });
  });

  it("returns a `content` string verbatim", async () => {
    const source = await resolveFileSource(
      { path: ".env", source: { kind: "content", content: "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("resolves a synchronous `content` function", async () => {
    const source = await resolveFileSource(
      {
        path: ".env",
        source: {
          kind: "content",
          content: (contentCtx) => {
            expect(contentCtx).toBe(ctx);
            expect(contentCtx.isMainWorktree).toBe(false);
            return "A=1\n";
          },
        },
      },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("awaits an asynchronous `content` function", async () => {
    const source = await resolveFileSource(
      {
        path: ".env",
        source: {
          kind: "content",
          content: async (contentCtx) => {
            expect(contentCtx).toBe(ctx);
            expect(contentCtx.isMainWorktree).toBe(false);
            return "A=1\n";
          },
        },
      },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });
});

describe("matchWorktreeByDir", () => {
  const registry: WorkspacesRegistry = {
    workspaces: {
      repo: { worktree: "/home/me/repo", createdAt: "", status: "ready", main: true },
      "repo-feat-a": { worktree: "/home/me/repo-feat-a", createdAt: "", status: "ready" },
      "repo-feat-b": { worktree: "/home/me/repo-feat-b", createdAt: "", status: "ready" },
    },
  };

  it("matches by absolute path", () => {
    expect(matchWorktreeByDir("/home/me/repo-feat-a", registry, "/home/me/repo")).toBe(
      "repo-feat-a",
    );
  });

  it("matches by relative path against cwd", () => {
    expect(matchWorktreeByDir("../repo-feat-b", registry, "/home/me/repo")).toBe("repo-feat-b");
  });

  it("matches by workspace name from anywhere", () => {
    expect(matchWorktreeByDir("repo-feat-a", registry, "/somewhere/else")).toBe("repo-feat-a");
  });

  it("matches an orphan by name even when its directory is gone", () => {
    expect(matchWorktreeByDir("repo-feat-b", registry, "/tmp")).toBe("repo-feat-b");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchWorktreeByDir("repo-feat-z", registry, "/home/me/repo")).toBeUndefined();
  });
});
