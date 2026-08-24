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

const LAYOUT: GuideLayout = {
  runtimeDir: ".local-wt",
  sharedDirs: [".local", ".plans"],
  hasDevServer: true,
  hasPorts: true,
  profiles: { claw: "HTTPS gateway environment" },
};

const SETUP_ONLY: GuideLayout = { ...LAYOUT, hasDevServer: false, hasPorts: false, profiles: {} };

describe("renderGuide", () => {
  it("renders npm commands with the `--` separator for forwarded args", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("npm run workspace -- setup -c my-branch");
    expect(guide).toContain("npm run dev -- up");
    // Bare foreground takes no forwarded args, so no separator.
    expect(guide).toMatch(/^npm run dev {2,}#/m);
  });

  it("renders pnpm commands without a separator", () => {
    const guide = renderGuide(PNPM, LAYOUT);
    expect(guide).toContain("pnpm workspace setup -c my-branch");
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
    const guide = renderGuide(NPM, { ...LAYOUT, sharedDirs: [] });
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

  it("documents ports and the dev server when both are configured", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("dedicated ports");
    expect(guide).toContain("## Dev server");
    expect(guide).toContain("**Concurrent cap.**");
    expect(guide).toContain("Driving the dev server in another worktree");
  });

  it("drops the port and dev-server material in setup-only mode", () => {
    const guide = renderGuide(NPM, SETUP_ONLY);
    expect(guide).not.toContain("dedicated ports");
    expect(guide).not.toContain("## Dev server");
    expect(guide).not.toContain("**Concurrent cap.**");
    expect(guide).not.toContain("npm run dev");
    expect(guide).toContain("`setup` creates the worktree (branch, symlinks, config files)");
  });

  it("lists the declared setup profiles, and nothing about profiles when none is declared", () => {
    const withProfiles = renderGuide(NPM, LAYOUT);
    expect(withProfiles).toContain("npm run workspace -- setup --profile <name>");
    expect(withProfiles).toContain("**Setup profiles:**");
    expect(withProfiles).toContain("- `claw` — HTTPS gateway environment");
    const withoutProfiles = renderGuide(NPM, { ...LAYOUT, profiles: {} });
    expect(withoutProfiles).not.toContain("--profile");
    expect(withoutProfiles).not.toContain("Setup profiles");
    expect(withoutProfiles).not.toContain("claw");
  });

  it("leaves no template marker and no blank-line gap in either mode", () => {
    for (const layout of [LAYOUT, SETUP_ONLY]) {
      const guide = renderGuide(NPM, layout);
      expect(guide).not.toContain("{{");
      expect(guide).not.toMatch(/\n\n\n/);
    }
  });
});
