import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { matchWorktreeByDir, type PatchContext, resolveConfigSource } from "../src/workspace.js";
import type { WorkspacesRegistry } from "../src/workspaces.js";

const ctx: PatchContext = {
  name: "repo-feat",
  ports: { server: 8110 },
  mainWorktree: "/repo/main",
  currentWorktree: "/repo/feat",
};

describe("resolveConfigSource", () => {
  it("reads a `mainWorktree` source at the entry's path in the main worktree", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "mainWorktree" } },
      ctx,
    );
    expect(source).toEqual({ path: join("/repo/main", ".env") });
  });

  it("reads a `newWorktree` source at the template path in the current worktree", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "newWorktree", path: ".env.example" } },
      ctx,
    );
    expect(source).toEqual({ path: join("/repo/feat", ".env.example") });
  });

  it("returns a `content` string verbatim", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("resolves a synchronous `content` function", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: () => "A=1\n" } },
      ctx,
    );
    expect(source).toEqual({ content: "A=1\n" });
  });

  it("awaits an asynchronous `content` function", async () => {
    const source = await resolveConfigSource(
      { path: ".env", source: { kind: "content", content: async () => "A=1\n" } },
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
