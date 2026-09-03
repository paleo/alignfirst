import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("doctor command", () => {
  it("always reports every section in an empty directory", async () => {
    const cwd = temp();
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    for (const section of ["CLI", "Config", "Plans", "Docmap", "Skills", "Overlay", "Companion"])
      expect(result.stdout).toContain(`] ${section}:`);
    expect(result.stdout).toContain("[warn] Companion: alcode not installed");
  });

  it("reports an excluded CLI range without failing", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0" }),
    );
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[error] Config: does not satisfy >=1.0.0");
  });

  it("continues after an invalid project config", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, ".alignfirst.json"), "{");
    const result = await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[error] Config: Invalid");
    expect(result.stdout).toContain("] Plans:");
  });

  it("reports a matching overlay and each effective file", async () => {
    const cwd = temp();
    const overlays = join(cwd, "overlays");
    const overlayDir = join(overlays, "project", "_project");
    mkdirSync(join(overlayDir, "docs"), { recursive: true });
    writeFileSync(
      join(overlayDir, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, project: { paths: [realpathSync(cwd)] } }),
    );
    writeFileSync(join(overlayDir, "AGENTS.md"), "agents\n");
    const result = await runMain(["doctor"], {
      cwd,
      env: { ALIGNFIRST_OVERLAYS: overlays, PATH: "" },
      home: cwd,
    });
    expect(result.stdout).toContain(`[ok] Overlay: ${overlayDir} (matched by paths)`);
    expect(result.stdout).toContain("[ok] Overlay: AGENTS.md overlay");
    expect(result.stdout).toContain("[ok] Overlay: DEVELOPERS.md none");
  });

  it("reports the alcode version", async () => {
    const cwd = temp();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    const alcode = join(bin, "alcode");
    writeFileSync(alcode, "#!/bin/sh\necho 0.13.0\n");
    chmodSync(alcode, 0o755);
    const result = await runMain(["doctor"], { cwd, env: { PATH: bin }, home: cwd });
    expect(result.stdout).toContain(`[ok] Companion: alcode 0.13.0 (${alcode})`);
  });
});

function temp(): string {
  const dir = makeTempDir("alignfirst-doctor-");
  dirs.push(dir);
  return dir;
}
