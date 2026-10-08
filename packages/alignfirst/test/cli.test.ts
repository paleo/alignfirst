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
    expect(help.stdout).toContain("alignfirst guide");
    expect(help.stdout).toContain("alignfirst conventions");
    expect(help.stdout).toContain("alignfirst context");
    expect(help.stdout).toContain("alignfirst doctor");
    expect(help.stdout).not.toContain("alignfirst setup");
    const version = await runMain(["--version"], { cwd });
    expect(version.stdout).toBe(`${packageVersion}\n`);
  });

  it("reports an unknown command with help", async () => {
    const result = await runMain(["unknown"], { cwd: temp() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: unknown command "unknown".');
    expect(result.stderr).toContain("alignfirst ticket");
  });

  it("guards project commands but exempts help, version, config and doctor", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0" }),
    );
    mkdirSync(join(cwd, ".plans"));
    const guarded = await runMain(["ticket", "78"], { cwd });
    expect(guarded.stderr).toBe(
      `alignfirst ${packageVersion} is installed; this project requires >=1.0.0.\n` +
        'Run a matching version:  npx -y alignfirst@">=1.0.0" ticket 78\n' +
        'Or install it globally:  npm install -g alignfirst@">=1.0.0"\n',
    );
    expect((await runMain(["--help"], { cwd })).code).toBe(0);
    expect((await runMain(["--version"], { cwd })).code).toBe(0);
    expect((await runMain(["config"], { cwd })).code).toBe(0);
    expect((await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd })).code).toBe(0);
  });

  it("lets doctor report an invalid config", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, ".alignfirst.json"), "{");
    expect((await runMain(["doctor"], { cwd, env: { PATH: "" }, home: cwd })).code).toBe(0);
  });

  it("guards with the range of a companion .alignfirst.json", async () => {
    const { root, home, project, companion } = makeCompanionProject({});
    dirs.push(root);
    mkdirSync(companion, { recursive: true });
    writeFileSync(
      join(companion, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0" }),
    );
    const guarded = await runMain(["conventions"], { cwd: project, home });
    expect(guarded.code).toBe(1);
    expect(guarded.stderr).toContain("this project requires >=1.0.0");
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
