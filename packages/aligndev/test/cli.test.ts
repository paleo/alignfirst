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
  it("lists the subcommands in its help", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await run([flag]);
      expect(result.code).toBe(0);
      for (const command of [
        "aligndev code",
        "aligndev project",
        "aligndev worktree",
        "aligndev guide",
      ]) {
        expect(result.stdout).toContain(command);
      }
      expect(result.stdout).not.toContain("aligndev plans");
      expect(result.stdout).toContain("~/.alignfirst/aligndev.settings.json");
    }
  });

  it.each([false, true])(
    "prints setup help without a repository or valid coding settings (npx=%s)",
    async (viaNpx) => {
      const env = viaNpx
        ? {
            npm_config_user_agent: "npm/11.19.0 node/v26.8.1 linux x64",
            npm_command: "exec",
            npm_lifecycle_event: "npx",
          }
        : {};
      const command = viaNpx ? "npx -y aligndev" : "aligndev";
      for (const args of [
        ["worktree", "--help"],
        ["worktree", "setup", "--help"],
        ["worktree", "setup", "-h"],
      ]) {
        const result = await run(args, { code: { agent: "invalid" } }, env);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`${command} worktree setup [<path>] [--json]`);
      }
    },
  );

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

  it("rejects the unpublished plans command without a compatibility alias", async () => {
    for (const args of [["plans"], ["plans", "--help"], ["plans", "check", "--json"]]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^Error: unknown command "plans"\.\n\naligndev — /);
      expect(result.stderr).not.toContain("aligndev plans");
    }
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

    const worktree = await run(["worktree", "--help"]);
    expect(worktree.code).toBe(0);
    expect(worktree.stdout).toContain("aligndev worktree add <path> <branch> [--json]");

    const guide = await run(["guide", "--help"], {
      platform: "openclaw",
      code: { agent: "claude" },
    });
    expect(guide.code).toBe(0);
    expect(guide.stdout).toContain(
      "aligndev guide [--channel <slack|discord|app>] [<topic>] [--root <path>]",
    );
  });
});
