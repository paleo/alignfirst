import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("docmap command", () => {
  it("injects the alignfirst command form", async () => {
    const cwd = temp();
    expect((await runMain(["docmap", "--help"], { cwd })).stdout).toContain(
      "alignfirst docmap --check",
    );
    expect(
      (
        await runMain(["docmap", "--guide"], {
          cwd,
          env: { npm_config_user_agent: "npm/11" },
        })
      ).stdout,
    ).toContain("npx -y alignfirst docmap --check");
  });

  it("falls back to overlay docs while root docs win", async () => {
    const cwd = temp();
    const overlays = join(cwd, "overlays");
    const overlayDir = join(overlays, "project", "_project");
    mkdirSync(join(overlayDir, "docs"), { recursive: true });
    writeFileSync(join(overlayDir, "docs", "overlay.md"), "# Overlay\n");
    writeFileSync(
      join(overlayDir, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, project: { paths: [realpathSync(cwd)] } }),
    );
    const env = { ALIGNFIRST_OVERLAYS: overlays };
    expect((await runMain(["docmap", "--recursive"], { cwd, env })).stdout).toContain("overlay.md");
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "root.md"), "# Root\n");
    const root = await runMain(["docmap", "--recursive"], { cwd, env });
    expect(root.stdout).toContain("root.md");
    expect(root.stdout).not.toContain("overlay.md");
  });

  it("propagates docmap exit codes", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "bad name.md"), "# Bad\n");
    expect((await runMain(["docmap", "--check"], { cwd })).code).toBe(1);
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
