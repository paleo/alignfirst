import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { makeSink, writeConfig } from "./helpers.js";

const NPX_ENV = { npm_config_user_agent: "npm/11.19.0 node/v26.0.0 linux x64" };

// A global-form command: not preceded by `npx -y `, and not a usage title such as `aldev code —`.
const GLOBAL_COMMAND = /(?<!npx -y )\baldev (code|project|guide)\b(?! —)/;

const CONFIG = { platform: "codingAgent", code: { agent: "claude" } };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("command forms", () => {
  it.each([
    ["the aldev help", ["--help"]],
    ["the code usage", ["code", "--help"]],
    ["the project usage", ["project", "--help"]],
    ["the guide usage", ["guide", "--help"]],
    ["the playbook", ["guide"]],
    ["the delegation guide", ["guide", "code"]],
  ])("prints the npx forms in %s under npx, the global forms otherwise", async (_name, args) => {
    const npx = await run(args, NPX_ENV);
    expect(npx.code, npx.stderr).toBe(0);
    expect(npx.stdout).toContain("npx -y aldev ");
    expect(npx.stdout).not.toMatch(GLOBAL_COMMAND);

    const global = await run(args, {});
    expect(global.code, global.stderr).toBe(0);
    expect(global.stdout).not.toContain("npx -y");
    expect(global.stdout).toMatch(GLOBAL_COMMAND);
  });

  it("prints the npx alignfirst form in the code usage and the delegation guide", async () => {
    for (const args of [
      ["code", "--help"],
      ["guide", "code"],
    ]) {
      const npx = await run(args, NPX_ENV);
      expect(npx.stdout).toContain("`npx -y alignfirst ticket --side`");
      const global = await run(args, {});
      expect(global.stdout).toContain("`alignfirst ticket --side`");
    }
  });

  it("spawns alignfirst through npx under npx", async () => {
    const home = makeHome();
    const bin = join(home, "bin");
    const log = join(home, "npx.log");
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`,
    );
    chmodSync(join(bin, "npx"), 0o755);

    const stderr = makeSink();
    const code = await main({
      argv: ["node", "aldev", "code", "status", "--no-ticket"],
      cwd: home,
      env: { ...NPX_ENV, PATH: bin, HOME: home },
      home,
      stdout: makeSink(),
      stderr,
    });

    expect(code).toBe(1);
    expect(readFileSync(log, "utf8")).toBe("-y alignfirst config --json\n");
  });
});

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = makeHome();
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await main({
    argv: ["node", "aldev", ...args],
    cwd: home,
    env,
    home,
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// A home with the config and an empty `bin/` directory.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aldev-forms-"));
  homes.push(home);
  writeConfig(home, CONFIG);
  mkdirSync(join(home, "bin"));
  return home;
}
