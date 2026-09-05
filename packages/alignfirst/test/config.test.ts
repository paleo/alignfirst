import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDir, packageVersion, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config command", () => {
  it("reports no config in text and JSON", async () => {
    const cwd = temp();
    expect((await runMain(["config"], { cwd })).stdout).toBe("Source: none\nCLI range: none\n");
    expect(JSON.parse((await runMain(["config", "--json"], { cwd })).stdout)).toEqual({
      source: null,
      cli: null,
      config: null,
    });
  });

  it("reports a root config and its unsatisfied range without failing", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, cli: ">=1.0.0", ticketIdPattern: "^\\d+$" }),
    );
    const result = await runMain(["config", "--json"], { cwd });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      source: "root",
      cli: { installed: packageVersion, range: ">=1.0.0", satisfied: false },
      config: { schemaVersion: 1, cli: ">=1.0.0", ticketIdPattern: "^\\d+$" },
    });
  });

  it("reports an invalid config as a CLI error", async () => {
    const cwd = temp();
    writeFileSync(join(cwd, ".alignfirst.json"), "{");
    const result = await runMain(["config"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Invalid ${join(cwd, ".alignfirst.json")}`);
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
