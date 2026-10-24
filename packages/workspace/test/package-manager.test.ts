import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchEvidence } from "@alignfirst/docmap/invocation";
import { afterEach, describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/package-manager.js";
import { renderGuide } from "../src/guide.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace invocation", () => {
  it("gives explicit manager evidence precedence over lockfiles", () => {
    const evidence = fixture("node");
    evidence.env = { npm_config_user_agent: "bun/1.4.4", npm_command: "exec" };
    const commands = detectPackageManager(evidence.cwd, evidence);
    expect(commands.workspace.base).toBe("bun run workspace");
    expect(commands.install).toBe("bun install");
  });

  it("retains verified Bun script identity with an npm lockfile, but not for dev", () => {
    const evidence = fixture("bun");
    const script = "bun scripts/workspace.mjs";
    writeFileSync(join(evidence.cwd, "package.json"), JSON.stringify({ scripts: { ws: script } }));
    evidence.env = {
      npm_config_user_agent: "bun/1.4.4",
      npm_command: "run-script",
      npm_lifecycle_event: "ws",
      npm_lifecycle_script: script,
      npm_package_json: join(evidence.cwd, "package.json"),
    };
    evidence.parentArgv = ["bun", "--bun", "run", "ws"];
    const commands = detectPackageManager(evidence.cwd, evidence, {
      workspace: evidence.entryPoint,
      dev: join(evidence.cwd, "scripts", "dev.mjs"),
    });
    expect(commands.workspace.withArgs).toBe("bun --bun run ws");
    expect(commands.dev.base).toContain("dev.mjs");
    expect(commands.dev.base).not.toContain("run ws");
  });

  it("preserves exact Bun executable paths for direct wrappers and bootstrap", () => {
    const evidence = fixture("bun");
    const commands = detectPackageManager(evidence.cwd, evidence, {
      workspace: evidence.entryPoint,
    });
    expect(commands.workspace.base).toBe(`'/runtime with spaces/bunx.exe' ${evidence.entryPoint}`);
    const guide = renderGuide(commands, { runtimeDir: ".wt", sharedDirs: [], hasDevServer: false });
    expect(guide).toContain(
      "'/runtime with spaces/bunx.exe' \"$main_worktree/<path-to>/workspace.mjs\" setup",
    );
    expect(guide).toContain("bun install");
    expect(guide).not.toContain("npm run");
  });

  it("does not reuse ambient evidence between resolutions", () => {
    const evidence = fixture("node");
    expect(detectPackageManager(evidence.cwd, evidence).workspace.withArgs).toBe(
      "npm run workspace --",
    );
    writeFileSync(join(evidence.cwd, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(evidence.cwd, evidence).workspace.base).toBe("pnpm workspace");
  });
});

function fixture(runtime: "node" | "bun"): LaunchEvidence {
  const cwd = mkdtempSync(join(tmpdir(), "workspace-invocation-"));
  roots.push(cwd);
  mkdirSync(join(cwd, "scripts"));
  const entryPoint = join(cwd, "scripts", "workspace.mjs");
  writeFileSync(entryPoint, "");
  writeFileSync(join(cwd, "package-lock.json"), "{}");
  return { cwd, runtime, env: {}, entryPoint, executable: "/runtime with spaces/bunx.exe" };
}
