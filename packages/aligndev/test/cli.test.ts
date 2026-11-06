import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { ALIGNFIRST_BIN, makeSink, writeConfig } from "./helpers.js";

const PACKAGE_JSON = new URL("../package.json", import.meta.url);

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function run(
  args: string[],
  config?: object,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "aligndev-cli-"));
  homes.push(home);
  if (config !== undefined) writeConfig(home, config);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "aligndev", ...args],
    cwd: home,
    env: { HOME: home, ...env },
    alignfirstCommand: [process.execPath, ALIGNFIRST_BIN],
    home,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("aligndev", () => {
  it("rejects retired worktree commands", async () => {
    for (const args of [["worktree"], ["worktree", "--help"], ["worktree", "setup", "--json"]]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
  });

  it("prints the package version", async () => {
    const { version } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      const result = await run([flag]);
      expect(result).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
    }
  });

  it.each([[], ["nope"]])("rejects missing or unknown commands %j", async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects the unpublished plans command without a compatibility alias", async () => {
    for (const args of [["plans"], ["plans", "--help"], ["plans", "check", "--json"]]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});
