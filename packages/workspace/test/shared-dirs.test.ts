import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceError } from "../src/errors.js";
import { linkSharedDirectories } from "../src/workspace.js";
import type { WorktreeContext } from "../src/worktree.js";

let tempRoot: string;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

function makeWorktrees(): { main: string; linked: string } {
  tempRoot = mkdtempSync(join(tmpdir(), "shared-dirs-"));
  const main = join(tempRoot, "main");
  const linked = join(tempRoot, "linked");
  mkdirSync(main);
  mkdirSync(linked);
  return { main, linked };
}

function linkedCtx(main: string, linked: string): WorktreeContext {
  return { currentWorktree: linked, mainWorktree: main, isMainWorktree: false };
}

describe("linkSharedDirectories", () => {
  it("creates a missing shared directory in the main worktree, then links it", () => {
    const { main, linked } = makeWorktrees();
    linkSharedDirectories(linkedCtx(main, linked), [".local"], () => {});
    expect(lstatSync(join(main, ".local")).isDirectory()).toBe(true);
    expect(readlinkSync(join(linked, ".local"))).toBe(join("..", "main", ".local"));
  });

  it("creates missing shared directories on a main-worktree setup, without symlinks", () => {
    const { main } = makeWorktrees();
    const ctx: WorktreeContext = {
      currentWorktree: main,
      mainWorktree: main,
      isMainWorktree: true,
    };
    linkSharedDirectories(ctx, [".local", ".plans"], () => {});
    expect(lstatSync(join(main, ".local")).isDirectory()).toBe(true);
    expect(lstatSync(join(main, ".plans")).isDirectory()).toBe(true);
    expect(lstatSync(join(main, ".plans")).isSymbolicLink()).toBe(false);
  });

  it("keeps an existing shared directory and an existing link untouched", () => {
    const { main, linked } = makeWorktrees();
    mkdirSync(join(main, ".local"));
    symlinkSync(join("..", "main", ".local"), join(linked, ".local"));
    const messages: string[] = [];
    linkSharedDirectories(linkedCtx(main, linked), [".local"], (msg) => messages.push(msg));
    expect(messages[0]).toBe("Skipped .local symlink (already exists).");
    expect(messages.some((msg) => msg.startsWith("Created"))).toBe(false);
  });

  it("follows a valid symlink in the main worktree (team plans repo layout)", () => {
    const { main, linked } = makeWorktrees();
    const clone = join(tempRoot, "clone");
    mkdirSync(clone);
    symlinkSync(join("..", "clone"), join(main, ".plans"));
    linkSharedDirectories(linkedCtx(main, linked), [".plans"], () => {});
    expect(readlinkSync(join(linked, ".plans"))).toBe(join("..", "main", ".plans"));
  });

  it("creates nested link parents and resolves the target from the link directory", () => {
    const { main, linked } = makeWorktrees();

    linkSharedDirectories(linkedCtx(main, linked), ["nested/artifacts"], () => {});

    const link = join(linked, "nested", "artifacts");
    expect(resolve(dirname(link), readlinkSync(link))).toBe(join(main, "nested", "artifacts"));
    expect(() =>
      linkSharedDirectories(linkedCtx(main, linked), ["nested/artifacts"], () => {}),
    ).not.toThrow();
  });

  it("fails on a broken symlink in the main worktree instead of shadowing it", () => {
    const { main, linked } = makeWorktrees();
    symlinkSync(join("..", "gone"), join(main, ".plans"));
    expect(() => linkSharedDirectories(linkedCtx(main, linked), [".plans"], () => {})).toThrow(
      WorkspaceError,
    );
    expect(existsSync(join(linked, ".plans"))).toBe(false);
  });

  it("excludes the created symlinks so a real linked worktree stays clean", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "shared-dirs-git-"));
    const main = join(tempRoot, "main");
    mkdirSync(main);
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
    git(main, "init", "-b", "main");
    git(
      main,
      "-c",
      "user.email=t@local",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "i",
    );
    const linked = join(tempRoot, "wt");
    git(main, "worktree", "add", linked, "-b", "b1");
    const inheritedExclude = join(tempRoot, "inherited-exclude");
    writeFileSync(inheritedExclude, "*.private\n");
    git(main, "config", "core.excludesFile", inheritedExclude);

    linkSharedDirectories(linkedCtx(main, linked), [".local", ".plans"], () => {});
    writeFileSync(join(main, ".local", "main-note"), "main\n");
    writeFileSync(join(linked, "kept.private"), "private\n");

    expect(git(linked, "status", "--porcelain").trim()).toBe("");
    expect(git(main, "status", "--porcelain")).toContain("?? .local/");
    const excludePath = git(
      linked,
      "config",
      "--worktree",
      "--path",
      "--get",
      "core.excludesFile",
    ).trim();
    expect(excludePath).toContain("/.git/worktrees/");
    expect(readFileSync(excludePath, "utf-8")).toContain("/.plans");
    expect(readFileSync(excludePath, "utf-8")).toContain("*.private");

    const sibling = join(tempRoot, "sibling");
    git(main, "worktree", "add", sibling, "-b", "b2");
    mkdirSync(join(sibling, ".local"));
    writeFileSync(join(sibling, ".local", "sibling-note"), "sibling\n");
    expect(git(sibling, "status", "--porcelain")).toContain("?? .local/");

    // Idempotent: a re-run appends nothing.
    linkSharedDirectories(linkedCtx(main, linked), [".local", ".plans"], () => {});
    const lines = readFileSync(excludePath, "utf-8").split("\n").filter(Boolean);
    expect(lines.filter((line) => line === "/.local")).toHaveLength(1);

    rmSync(excludePath);
    mkdirSync(excludePath);
    const messages: string[] = [];
    expect(() =>
      linkSharedDirectories(linkedCtx(main, linked), [".local", ".plans"], (message) =>
        messages.push(message),
      ),
    ).not.toThrow();
    expect(messages.some((message) => message.startsWith("Skipped shared-symlink"))).toBe(true);
  });
});
