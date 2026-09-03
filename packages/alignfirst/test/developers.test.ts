import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DEVELOPERS.md command", () => {
  it("prints the root file", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, "DEVELOPERS.md"), "root guide\n");
    expect((await runMain(["DEVELOPERS.md"], { cwd })).stdout).toBe("root guide\n");
  });

  it("prints an overlay file and reports every tried path when absent", async () => {
    const cwd = temp();
    const overlays = join(cwd, "overlays");
    const overlayDir = join(overlays, "project", "_project");
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(
      join(overlayDir, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, project: { paths: [realpathSync(cwd)] } }),
    );
    const env = { ALIGNFIRST_OVERLAYS: overlays };
    writeFileSync(join(overlayDir, "DEVELOPERS.md"), "overlay guide\n");
    expect((await runMain(["DEVELOPERS.md"], { cwd, env })).stdout).toBe("overlay guide\n");
    rmSync(join(overlayDir, "DEVELOPERS.md"));
    const missing = await runMain(["DEVELOPERS.md"], { cwd, env });
    expect(missing.stderr).toContain(join(cwd, "DEVELOPERS.md"));
    expect(missing.stderr).toContain(join(overlayDir, "DEVELOPERS.md"));
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
