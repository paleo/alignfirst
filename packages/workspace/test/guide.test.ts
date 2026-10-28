import { createCommand } from "@alignfirst/docmap/invocation";
import { describe, expect, it } from "vitest";

import { type GuideLayout, renderGuide } from "../src/guide.js";
import { defaultCommands, type WorkspaceCommands } from "../src/invocation.js";

const BUN: WorkspaceCommands = {
  workspace: createCommand("bunx", ["--bun", "alignfirst", "workspace"]),
  dev: createCommand("bunx", ["--bun", "alignfirst", "dev"]),
};
const LAYOUT: GuideLayout = {
  runtimeDir: ".local-wt",
  sharedDirs: [".shared"],
  hasDevServer: true,
};
const SETUP_ONLY: GuideLayout = { ...LAYOUT, hasDevServer: false };

describe("renderGuide", () => {
  it.each([defaultCommands, BUN])(
    "renders installed CLI commands and external hooks: %j",
    (commands) => {
      for (const layout of [LAYOUT, SETUP_ONLY]) {
        const guide = renderGuide(commands, layout);
        expect(guide).toContain(`${commands.workspace.withArgs} setup -c my-branch`);
        expect(guide).toContain(`${commands.workspace.withArgs} setup --path ../external-worktree`);
        expect(guide).toContain(`${commands.workspace.withArgs} teardown <registered-name>`);
        expect(guide).toContain(`${commands.workspace.withArgs} teardown ../my-worktree`);
        expect(guide).toContain("Paths select exactly; there is no basename-search fallback");
        expect(guide).toContain("names, collision suffixes and ports are not reserved");
        expect(guide).toContain(
          "Internal finalization and dev-setup children retain that CLI installation and runtime",
        );
        expect(guide).toContain("Main-worktree teardown preserves the shared registry");
        expect(guide).not.toContain("workspace.mjs");
        expect(guide).not.toContain("npm run");
        expect(guide).not.toContain("{{");
        expect(guide).not.toMatch(/\n\n\n/);
      }
    },
  );

  it("keeps replacement-pattern characters literal in commands and layout", () => {
    const token = "$&";
    const workspace = createCommand(`alignfirst${token}`, ["workspace"]);
    const dev = createCommand(`alignfirst${token}`, ["dev"]);
    const runtimeDir = `.runtime-${token}`;
    const sharedDir = `.shared-${token}`;
    const guide = renderGuide(
      { workspace, dev },
      { ...LAYOUT, runtimeDir, sharedDirs: [sharedDir] },
    );
    expect(guide).toContain(`${workspace.withArgs} setup -c my-branch`);
    expect(guide).toContain(`${dev.withArgs} up`);
    expect(guide).toContain(`cd <worktree-dir> && ${dev.withArgs} up`);
    expect(guide).toContain(`\`${runtimeDir}/\``);
    expect(guide).toContain(`Additional shared directories: \`${sharedDir}/\`.`);
  });

  it("describes mandatory defaults independently of extra shared directories", () => {
    for (const sharedDirs of [[], LAYOUT.sharedDirs]) {
      const guide = renderGuide(defaultCommands, { ...LAYOUT, sharedDirs });
      expect(guide).toContain("Effective plans");
      expect(guide).toContain("untracked `.local/`");
      expect(guide).toContain("`.local-wt/`");
      expect(guide).toContain("`workspace-registry/`");
      expect(guide).toContain("Without a manifest");
      expect(guide).toContain("completes synchronously");
      expect(guide).toContain("Setup never provisions plans");
      expect(guide).toContain("stdout contains one result document");
    }
  });

  it("aligns comments within a dev command block", () => {
    const guide = renderGuide(defaultCommands, LAYOUT);
    const block = guide.slice(guide.indexOf("## Dev server"), guide.indexOf("**Concurrent cap."));
    const columns = block
      .split("\n")
      .filter((line) => line.startsWith("alignfirst dev ") && line.includes(" # "))
      .map((line) => line.indexOf(" # "));
    expect(columns.length).toBeGreaterThan(1);
    expect(new Set(columns).size).toBe(1);
  });

  it("shows dev setup/full only when the target declares managed services", () => {
    const guide = renderGuide(defaultCommands, LAYOUT);
    expect(guide).toContain("dedicated ports");
    expect(guide).toContain("alignfirst dev setup --force");
    expect(guide).toContain("alignfirst dev setup --reset-ports");
    expect(guide).toContain("alignfirst workspace setup -c my-branch --full");
    expect(guide).toContain("allocated at its first dev start, stay fixed");
    expect(guide).toContain("stops dev processes and configured callbacks");
    const setupOnly = renderGuide(defaultCommands, SETUP_ONLY);
    expect(setupOnly).not.toContain("## Dev server");
    expect(setupOnly).not.toContain("**Concurrent cap.**");
    expect(setupOnly).not.toContain("alignfirst dev");
    expect(setupOnly).not.toContain("--full");
    expect(setupOnly).toContain("Without one, it adopts the current Git worktree");
  });
});
