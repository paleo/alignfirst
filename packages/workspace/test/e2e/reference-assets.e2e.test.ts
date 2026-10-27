import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { packageRoot } from "./fixture.js";

const repository = resolve(packageRoot, "../..");
const assets = join(repository, "skills/alignfirst-setup-guide/assets");
const cli = join(repository, "packages/alignfirst/bin/alignfirst.mjs");

it("publishes manifest examples accepted by the production CLI without consumer dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "reference-manifest-"));
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    for (const { directory, filename, portRange } of [
      { directory: assets, filename: "alignfirst.json", portRange: { first: 8100, last: 8199 } },
      {
        directory: join(assets, "aligndev-openclaw-template/base"),
        filename: "alignfirst.jsonc",
        portRange: null,
      },
      {
        directory: join(repository, "aligndev-openclaw-tests/projects-fixture/template"),
        filename: "alignfirst.json",
        portRange: { first: 6500, last: 6519 },
      },
    ]) {
      const path = join(project, filename);
      cpSync(join(directory, filename), path);
      const result = spawnSync(process.execPath, [cli, "config", "--json"], {
        cwd: project,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        config: { schemaVersion: 1 },
        workspace: {
          location: { path },
          schemaVersion: 1,
          portRange,
          hasDevServer: portRange !== null,
        },
      });
      if (directory === assets) {
        expect(report.config.devServer.maxConcurrentDevServers).toEqual({
          env: "PROJECT_DEV_LIMIT",
          default: 5,
        });
        expect(report.config.devServer.servers[0].error).toEqual({ preset: "node" });
        expect(report.locations.developerInstructions).toBeNull();
      } else {
        expect(report.config.developerInstructions).toBe("DEVELOPERS.md");
        expect(report.locations.developerInstructions.path).toBe(join(project, "DEVELOPERS.md"));
      }
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
