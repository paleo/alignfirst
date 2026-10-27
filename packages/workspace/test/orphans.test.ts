import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findOrphanNames } from "../src/orphans.js";
import { runWorkspace } from "../src/workspace.js";
import {
  type WorkspacesRegistry,
  writeWorkspaces,
  registryDirFor,
  workspacesFilePath,
} from "../src/workspaces.js";

function registry(): WorkspacesRegistry {
  return {
    workspaces: {
      main: {
        worktree: "/repo/main",
        createdAt: "2026-05-10T00:00:00.000Z",
        status: "ready",
        main: true,
        recipe: { kind: "defaults" },
      },
      "wt-a": {
        worktree: "/repo/wt-a",
        createdAt: "2026-05-10T00:00:00.000Z",
        status: "ready",
        recipe: { kind: "defaults" },
      },
      "wt-b": {
        worktree: "/repo/wt-b",
        createdAt: "2026-05-10T00:00:00.000Z",
        status: "ready",
        recipe: { kind: "defaults" },
      },
    },
  };
}

describe("findOrphanNames", () => {
  it("listing retains every orphan identity without mutating registries or purging infrastructure", async () => {
    const root = mkdtempSync(join(tmpdir(), "orphan-list-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const registryDir = registryDirFor(".local-wt");
      const data = registry();
      data.workspaces["wt-b"].status = "pending";
      writeWorkspaces(root, registryDir, {
        workspaces: { "wt-a": data.workspaces["wt-a"], "wt-b": data.workspaces["wt-b"] },
      });
      const path = workspacesFilePath(root, registryDir);
      const before = readFileSync(path, "utf8");
      const lines: string[] = [];
      let purges = 0;
      await runWorkspace(
        {
          runtimeDir: ".local-wt",
          sharedDirs: [],
          gitignoredFiles: [],
          recipe: { kind: "defaults" },
          hasDevServer: false,
          formatSummary: () => "",
          purgeInfrastructure: () => {
            ++purges;
          },
        },
        {
          cwd: root,
          env: {},
          invocation: { executable: process.execPath, entryPoint: join(root, "alignfirst.mjs") },
          command: { kind: "list" },
          verbose: false,
          output: {
            text: (line) => lines.push(line),
            diagnostic: (line) => lines.push(line),
            write: () => {},
            isTTY: false,
          },
        },
      );
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(lines.join("\n")).toContain("wt-a");
      expect(lines.join("\n")).toContain("wt-b");
      expect(purges).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns linked workspaces whose worktree directory is missing", () => {
    const exists = (p: string) => p !== "/repo/wt-b";
    expect(findOrphanNames(registry(), exists)).toEqual(["wt-b"]);
  });

  it("never reports the main worktree even when its directory is missing", () => {
    expect(findOrphanNames(registry(), () => false)).toEqual(["wt-a", "wt-b"]);
  });

  it("returns an empty array when every worktree exists", () => {
    expect(findOrphanNames(registry(), () => true)).toEqual([]);
  });
});
