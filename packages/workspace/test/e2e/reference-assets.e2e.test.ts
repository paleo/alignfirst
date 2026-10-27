import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadWorkspaceManifest } from "../../src/config.js";
import { packageRoot } from "./fixture.js";

const repository = resolve(packageRoot, "../..");
const assets = join(repository, "skills/alignfirst-setup-guide/assets");
const cli = join(repository, "packages/alignfirst/bin/alignfirst.mjs");

it("publishes manifest examples accepted by the production CLI without consumer dependencies", () => {
  for (const directory of [
    assets,
    join(assets, "aligndev-openclaw-template/base"),
    join(repository, "aligndev-openclaw-tests/projects-fixture/template"),
  ]) {
    expect(loadWorkspaceManifest(directory)?.schemaVersion).toBe(1);
  }
  const root = mkdtempSync(join(tmpdir(), "reference-manifest-"));
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    cpSync(join(assets, "alignfirst-workspace.json"), join(project, "alignfirst-workspace.json"));
    const result = spawnSync(process.execPath, [cli, "config", "--json"], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).workspace).toMatchObject({
      schemaVersion: 1,
      portRange: { first: 8100, last: 8199 },
      hasDevServer: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
