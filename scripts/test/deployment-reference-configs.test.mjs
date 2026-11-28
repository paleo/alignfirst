import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repository, "packages/alignfirst/bin/alignfirst.mjs");

const references = [
  {
    name: "OpenClaw deployment template",
    directory: join(
      repository,
      "skills/aligndev-openclaw-setup/assets/aligndev-openclaw-template/base",
    ),
    filename: "alignfirst.jsonc",
    portRange: null,
  },
  {
    name: "OpenClaw projects fixture",
    directory: join(repository, "aligndev-openclaw-tests/projects-fixture/template"),
    filename: "alignfirst.json",
    portRange: { first: 6500, last: 6519 },
  },
];

for (const { name, directory, filename, portRange } of references) {
  test(`${name} manifest is accepted by the production CLI`, () => {
    const root = mkdtempSync(join(tmpdir(), "deployment-reference-config-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      mkdirSync(home);
      mkdirSync(project);
      const path = join(project, filename);
      cpSync(join(directory, filename), path);
      const report = readConfigReport(project, home);
      assert.equal(report.config.schemaVersion, 1);
      assert.equal(report.config.assistantInstructionsFile, undefined);
      assert.equal(report.workspace.location.path, path);
      assert.equal(report.workspace.schemaVersion, 1);
      assert.deepEqual(report.workspace.portRange, portRange);
      assert.equal(report.workspace.hasDevServer, portRange !== null);
      const instructions = report.locations.assistantInstructionsFile;
      assert.equal(instructions.path, join(project, "ASSISTANTS.md"));
      assert.equal(instructions.exists, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function readConfigReport(project, home) {
  const result = spawnSync(process.execPath, [cli, "config", "--json"], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
