import { scriptCommand } from "@alignfirst/docmap/invocation";
import { describe, expect, it } from "vitest";

import { type GuideLayout, renderGuide } from "../src/guide.js";
import type { PackageManagerCommands } from "../src/package-manager.js";

const NPM: PackageManagerCommands = {
  install: "npm install",
  runtime: "node",
  workspace: { base: "npm run workspace", withArgs: "npm run workspace --" },
  dev: { base: "npm run dev", withArgs: "npm run dev --" },
};

const PNPM: PackageManagerCommands = {
  install: "pnpm i",
  runtime: "node",
  workspace: { base: "pnpm workspace", withArgs: "pnpm workspace" },
  dev: { base: "pnpm dev", withArgs: "pnpm dev" },
};

const LAYOUT: GuideLayout = {
  runtimeDir: ".local-wt",
  sharedDirs: [".local", ".plans"],
  hasDevServer: true,
};

const SETUP_ONLY: GuideLayout = { ...LAYOUT, hasDevServer: false };

describe("renderGuide", () => {
  it("renders npm commands with the `--` separator for forwarded args", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("npm run workspace -- setup -c my-branch");
    expect(guide).toContain("npm run dev -- up");
    // Bare foreground takes no forwarded args, so no separator.
    expect(guide).toMatch(/^npm run dev {2,}#/m);
  });

  it("renders `$&` literally in commands and layout, not as a replacement pattern", () => {
    const token = "$&";
    const workspace = scriptCommand("npm", `workspace${token}`);
    const dev = scriptCommand("npm", `dev${token}`);
    const runtimeDir = `.local-${token}`;
    const sharedDir = `.shared-${token}`;
    const guide = renderGuide(
      { ...NPM, workspace, dev },
      { ...LAYOUT, runtimeDir, sharedDirs: [sharedDir] },
    );
    expect(guide).toContain(`${workspace.withArgs} setup -c my-branch`);
    expect(guide).toContain(`${dev.withArgs} up`);
    expect(guide).toContain(`Ports and infrastructure arrive with the first \`${dev.base}\``);
    expect(guide).toContain(`cd <worktree-dir> && ${dev.withArgs} up`);
    expect(guide).toContain(`\`${runtimeDir}/\``);
    expect(guide).toContain(`symlinked from the main worktree: \`${sharedDir}/\`.`);
    expect(guide).not.toContain("{{");
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

  it("documents ports, `dev setup` and `setup --full` with a dev server", () => {
    const guide = renderGuide(NPM, LAYOUT);
    expect(guide).toContain("dedicated ports");
    expect(guide).toContain("Ports and infrastructure arrive with the first `npm run dev`");
    expect(guide).toContain("## Dev server");
    expect(guide).toContain("**Concurrent cap.**");
    expect(guide).toContain("Driving the dev server in another worktree");
    expect(guide).toMatch(/^npm run dev -- setup {2,}#/m);
    expect(guide).toContain("npm run dev -- setup --force");
    expect(guide).toContain("npm run dev -- setup --reset-ports");
    expect(guide).toContain("npm run workspace -- setup -c my-branch --full");
    expect(guide).toContain("allocated at its first dev start, stay fixed");
  });

  it("drops the port and dev-server material in setup-only mode", () => {
    const guide = renderGuide(NPM, SETUP_ONLY);
    expect(guide).not.toContain("dedicated ports");
    expect(guide).not.toContain("## Dev server");
    expect(guide).not.toContain("**Concurrent cap.**");
    expect(guide).not.toContain("npm run dev");
    expect(guide).not.toContain("--full");
    expect(guide).toContain("Without one, it adopts the current Git worktree");
  });

  it.each([NPM, PNPM])("renders external hooks and teardown in both modes: %j", (pm) => {
    for (const layout of [LAYOUT, SETUP_ONLY]) {
      const guide = renderGuide(pm, layout);
      expect(guide).toContain(`${pm.install} && ${pm.workspace.withArgs} setup`);
      expect(guide).toContain(`${pm.workspace.withArgs} teardown <registered-name>`);
      expect(guide).toContain(`${pm.workspace.withArgs} teardown ../my-worktree`);
      expect(guide).toContain("Paths select exactly; there is no basename-search fallback");
      expect(guide).toContain("names, collision suffixes and ports are not reserved");
      expect(guide).toContain('node "$main_worktree/<path-to>/workspace.mjs" setup');
      expect(guide).toContain("Main-worktree teardown preserves the shared registry");
      if (layout.hasDevServer) {
        expect(guide).toContain(`${pm.install} && ${pm.workspace.withArgs} setup --full`);
        expect(guide).toContain("stops dev processes and configured callbacks");
      } else {
        expect(guide).not.toContain("--full");
        expect(guide).not.toContain(pm.dev.base);
      }
    }
  });

  it("leaves no template marker and no blank-line gap in either mode", () => {
    for (const layout of [LAYOUT, SETUP_ONLY]) {
      const guide = renderGuide(NPM, layout);
      expect(guide).not.toContain("{{");
      expect(guide).not.toMatch(/\n\n\n/);
    }
  });
});
