import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { makeSink, writeConfig } from "./helpers.js";

const PACKAGE_JSON = new URL("../package.json", import.meta.url);

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function run(
  args: string[],
  config?: object,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "aligndev-cli-"));
  homes.push(home);
  if (config !== undefined) writeConfig(home, config);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "aligndev", ...args],
    cwd: home,
    env: {},
    home,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("aligndev", () => {
  it("lists the three subcommands in its help", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await run([flag]);
      expect(result.code).toBe(0);
      for (const command of ["aligndev code", "aligndev project", "aligndev guide"]) {
        expect(result.stdout).toContain(command);
      }
      expect(result.stdout).toContain("~/.config/alignfirst/aligndev.config.json");
    }
  });

  it("prints the package version", async () => {
    const { version } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) {
      const result = await run([flag]);
      expect(result).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
    }
  });

  it("rejects a missing or unknown subcommand with the help on stderr", async () => {
    const missing = await run([]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^Error: no command given\.\n\naligndev — /);

    const unknown = await run(["nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/^Error: unknown command "nope"\.\n\naligndev — /);
  });

  it("delegates --help to each subcommand", async () => {
    const code = await run(["code", "--help"], {
      platform: "codingAgent",
      code: { agent: "claude" },
    });
    expect(code.code).toBe(0);
    expect(code.stdout).toMatch(/^aligndev code — /);

    const project = await run(["project", "--help"]);
    expect(project.code).toBe(0);
    expect(project.stdout).toContain("aligndev project list [--json] [--root <path>]");

    const guide = await run(["guide", "--help"], {
      platform: "openclaw",
      code: { agent: "claude" },
    });
    expect(guide.code).toBe(0);
    expect(guide.stdout).toContain("aligndev guide [<topic>] [--root <path>]");
  });
});
