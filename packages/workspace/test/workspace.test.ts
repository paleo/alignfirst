import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type GitignoredFileSource,
  type PatchContext,
  resolveFileSource,
} from "../src/file-entries.js";
import { matchWorktreeByDir } from "../src/workspace.js";
import type { WorkspaceEntry, WorkspacesRegistry } from "../src/workspaces.js";

describe("resolveFileSource", () => {
  let root: string;
  let ctx: PatchContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workspace-source-test-"));
    const mainWorktree = join(root, "main");
    const currentWorktree = join(root, "external", "nested", "feat");
    mkdirSync(mainWorktree);
    mkdirSync(currentWorktree, { recursive: true });
    ctx = { name: "repo-feat", mainWorktree, currentWorktree, isMainWorktree: false };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each<[string, GitignoredFileSource, boolean, "main" | "current", string]>([
    ["a main-worktree file at the entry path", { kind: "mainWorktree" }, false, "main", ".env"],
    [
      "an existing main-worktree file over its fallback",
      { kind: "mainWorktree", fallback: ".env.example" },
      true,
      "main",
      ".env",
    ],
    [
      "the current worktree's fallback when the main file is absent",
      { kind: "mainWorktree", fallback: ".env.example" },
      false,
      "current",
      ".env.example",
    ],
    [
      "a committed template in the current worktree",
      { kind: "committed", path: ".env.example" },
      false,
      "current",
      ".env.example",
    ],
  ])("resolves %s", async (_, source, mainExists, tree, path) => {
    if (mainExists) writeFileSync(join(ctx.mainWorktree, ".env"), "MAIN=1\n");
    writeFileSync(join(ctx.currentWorktree, ".env.example"), "FALLBACK=1\n");
    const resolved = await resolveFileSource({ path: ".env", source }, ctx);
    const base = tree === "main" ? ctx.mainWorktree : ctx.currentWorktree;
    expect(resolved).toEqual({ path: join(base, path) });
  });
});

describe("matchWorktreeByDir", () => {
  const entry = (worktree: string): WorkspaceEntry => ({
    worktree,
    createdAt: "",
    status: "ready",
    recipe: { kind: "defaults" },
  });
  const registry: WorkspacesRegistry = {
    workspaces: {
      repo: { ...entry("/home/me/repo"), main: true },
      "repo-feat-a": entry("/home/me/repo-feat-a"),
      wt: entry("/first/wt"),
      "wt-deadbeef": entry("/second/wt"),
    },
  };

  it.each<[string, string, string | undefined]>([
    ["/home/me/repo-feat-a", "/home/me/repo", "repo-feat-a"],
    ["../repo-feat-a", "/home/me/repo", "repo-feat-a"],
    ["repo-feat-a", "/somewhere/else", "repo-feat-a"],
    ["wt", "/second", "wt-deadbeef"],
    ["wt", "/elsewhere", "wt"],
    ["/unknown/wt", "/elsewhere", undefined],
    ["../unknown/wt", "/elsewhere", undefined],
    ["repo-feat-z", "/home/me/repo", undefined],
  ])("matches %s from %s as %s", (selector, cwd, expected) => {
    expect(matchWorktreeByDir(selector, registry, cwd)).toBe(expected);
  });
});
