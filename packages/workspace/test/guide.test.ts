import { describe, expect, it } from "vitest";

import { type GuideLayout, renderGuide } from "../src/guide.js";
import type { PackageManagerCommands } from "../src/package-manager.js";

const NPM: PackageManagerCommands = {
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

const PNPM: PackageManagerCommands = {
  workspace: { base: "pnpm workspace", withArgs: "pnpm workspace" },
  dev: { base: "pnpm dev", withArgs: "pnpm dev" },
};

const LAYOUT: GuideLayout = { runtimeDir: ".local-wt", sharedDirs: [".local", ".plans"] };

describe("renderGuide", () => {
  it("renders npm commands with the `--` separator for forwarded args", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("npm run workspace -- setup my-branch -c");
    expect(guide).toContain("npm run dev -- up");
    // Bare foreground takes no forwarded args, so no separator.
    expect(guide).toMatch(/^npm run dev {2,}#/m);
  });

  it("renders pnpm commands without a separator", () => {
    const guide = renderGuide(PNPM, LAYOUT);
    expect(guide).toContain("pnpm workspace setup my-branch -c");
    expect(guide).toContain("pnpm dev up");
    expect(guide).not.toContain("pnpm dev --");
  });

  it("renders the configured runtime dir, the fixed registry sub-dir, and named shared dirs", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("`.local-wt/`");
    expect(guide).toContain("`workspace-registry/`");
    expect(guide).toContain("symlinked from the main worktree: `.local/`, `.plans/`.");
  });

  it("states when no dirs are shared across worktrees", () => {
    const guide = renderGuide(NPM, { runtimeDir: ".local-wt", sharedDirs: [] });
    expect(guide).toContain("No dirs are shared across worktrees.");
    expect(guide).not.toContain("`.plans/`");
  });

  it("aligns the `#` comments within a command block", () => {
    const guide = renderGuide(NPM, LAYOUT);
    const block = guide.slice(guide.indexOf("## Dev server"), guide.indexOf("**Concurrent cap."));
    const commentColumns = block
      .split("\n")
      .filter((line) => line.startsWith("npm run dev ") && line.includes(" # "))
      .map((line) => line.indexOf(" # "));
    expect(commentColumns.length).toBeGreaterThan(1);
    expect(new Set(commentColumns).size).toBe(1);
  });
});
