import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeCompanionProject, makeTempDir, packageVersion, runMain } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("alignfirst CLI", () => {
  it("prints help and version", async () => {
    const cwd = temp();
    const help = await runMain([], { cwd });
    expect(help).toMatchObject({ code: 0, stderr: "" });
    for (const command of ["guide", "conventions", "context", "doctor"])
      expect(help.stdout).toContain(`alignfirst ${command}`);
    expect((await runMain(["--version"], { cwd })).stdout).toBe(`${packageVersion}\n`);
  });

  it("reports unknown commands with help", async () => {
    const result = await runMain(["unknown"], { cwd: temp() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: unknown command "unknown".');
    expect(result.stderr).toContain("alignfirst ticket");
  });

  it("rejects retired settings for project commands while help/version remain usable", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0" }),
    );
    const result = await runMain(["conventions"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("/cli");
    expect(result.stderr).toContain("update alignfirst");
    expect((await runMain(["--help"], { cwd })).code).toBe(0);
    expect((await runMain(["--version"], { cwd })).code).toBe(0);
    expect((await runMain(["config"], { cwd })).code).toBe(1);
    const doctor = await runMain(["doctor"], { cwd });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("[error] alignfirst:");
  });

  it("does not load the retired filename", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, ".alignfirst.json"), "{");
    expect((await runMain(["conventions"], { cwd })).code).toBe(0);
  });

  it("validates selected companion configuration", async () => {
    const { root, home, project, companion } = makeCompanionProject({});
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(
      join(companion, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, plans: { folder: "x" } }),
    );
    const result = await runMain(["conventions"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("/plans/folder");
    expect(result.stderr).toContain(join(companion, "alignfirst.json"));
  });

  it("fails project commands on an invalid registry", async () => {
    const { root, home, project } = makeCompanionProject({ docs: "yes" });
    dirs.push(root);
    const result = await runMain(["conventions"], { cwd: project, home });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Invalid ${join(home, ".alignfirst", "companions", "registry.json")}: `,
    );
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
