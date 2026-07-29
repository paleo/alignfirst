import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(messages).toEqual(["Skipped .local symlink (already exists)."]);
  });

  it("follows a valid symlink in the main worktree (team plans repo layout)", () => {
    const { main, linked } = makeWorktrees();
    const clone = join(tempRoot, "clone");
    mkdirSync(clone);
    symlinkSync(join("..", "clone"), join(main, ".plans"));
    linkSharedDirectories(linkedCtx(main, linked), [".plans"], () => {});
    expect(readlinkSync(join(linked, ".plans"))).toBe(join("..", "main", ".plans"));
  });

  it("fails on a broken symlink in the main worktree instead of shadowing it", () => {
    const { main, linked } = makeWorktrees();
    symlinkSync(join("..", "gone"), join(main, ".plans"));
    expect(() => linkSharedDirectories(linkedCtx(main, linked), [".plans"], () => {})).toThrow(
      WorkspaceError,
    );
    expect(existsSync(join(linked, ".plans"))).toBe(false);
  });
});
